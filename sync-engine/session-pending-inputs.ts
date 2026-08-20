import { and, asc, eq, max } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import { createdAuditFields, softDeletedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentMessages,
  agentPendingInputs,
  agentSessions,
} from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type {
  AgentSessionPendingInput,
  AgentSessionPendingInputKind,
} from "../shared/session-model.ts";
import { storedActiveSessionState } from "./session-active-query.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import { currentSessionSegment } from "./session-segment.ts";
import { notifySessionSteeringInput } from "./session-steering-wakeup.ts";
import { sessionTimingUpdate } from "./session-store-persistence.ts";
import type { StoredUserMessageInput } from "./session-store-types.ts";
import {
  nextStoredMessageTimestamp,
  userMessageValues,
} from "./session-store-values.ts";
import { touchStoredSession } from "./session-touch.ts";
import {
  activeSessionTurnId,
  endGenerationSessionTurn,
  rotateSessionTurn,
} from "./session-turn-store.ts";
import {
  parseStoredImages,
  serializeStoredImages,
} from "./stored-agent-images.ts";

export interface EnqueuePendingSessionInput {
  readonly clientRequestId: string;
  readonly content: string;
  readonly images: readonly AgentImage[];
  readonly kind: AgentSessionPendingInputKind;
}

export type EnqueuePendingInputResult =
  | { readonly input: AgentSessionPendingInput; readonly status: "accepted" }
  | { readonly input: AgentSessionPendingInput; readonly status: "duplicate" }
  | { readonly status: "conflict" | "invalid_state" | "not_found" };

interface StoredPendingInput {
  readonly clientRequestId: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly images: string | null;
  readonly kind: AgentSessionPendingInputKind;
  readonly sequence: number;
  readonly sessionId: string;
}

function storedPendingInput(
  stored: StoredPendingInput,
): AgentSessionPendingInput {
  const attachments = parseStoredImages(
    stored.images,
    "Stored pending session attachments are invalid",
  );
  return {
    clientRequestId: stored.clientRequestId,
    content: stored.content,
    createdAt: stored.createdAt.getTime(),
    id: stored.id,
    images: attachments,
    kind: stored.kind,
  };
}

const PENDING_SELECTION = {
  clientRequestId: agentPendingInputs.clientRequestId,
  content: agentPendingInputs.content,
  createdAt: agentPendingInputs.createdAt,
  id: agentPendingInputs.id,
  images: agentPendingInputs.images,
  kind: agentPendingInputs.kind,
  sequence: agentPendingInputs.sequence,
  sessionId: agentPendingInputs.sessionId,
};

const CANCELLABLE_PENDING_SELECTION = {
  ...PENDING_SELECTION,
  isDeleted: agentPendingInputs.isDeleted,
};

function matchesDuplicate(
  stored: StoredPendingInput,
  sessionId: string,
  input: EnqueuePendingSessionInput,
): boolean {
  return (
    stored.sessionId === sessionId &&
    stored.kind === input.kind &&
    stored.content === input.content &&
    stored.images === serializeStoredImages(input.images)
  );
}

function insertPendingInput(
  database: Pick<AppDatabase, "insert">,
  values: typeof agentPendingInputs.$inferInsert,
): void {
  database.insert(agentPendingInputs).values(values).run();
}

function pendingCondition(sessionId: string) {
  return and(
    eq(agentPendingInputs.sessionId, sessionId),
    eq(agentPendingInputs.isDeleted, false),
  );
}

function orderedActiveInputs(query: ReturnType<typeof activeInputQuery>) {
  return query.orderBy(asc(agentPendingInputs.sequence));
}

function activeInputQuery(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
) {
  return database
    .select(PENDING_SELECTION)
    .from(agentPendingInputs)
    .where(pendingCondition(sessionId));
}

function firstPendingInput(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): StoredPendingInput | undefined {
  return orderedActiveInputs(activeInputQuery(database, sessionId)).get();
}

function activeInputs(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly StoredPendingInput[] {
  return orderedActiveInputs(activeInputQuery(database, sessionId)).all();
}

export interface PendingInputForPromotion extends Pick<
  StoredUserMessageInput,
  "content" | "sessionId"
> {
  readonly id: string;
  readonly images: readonly AgentImage[];
}

export function activePendingInput(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): PendingInputForPromotion | undefined {
  const pending = firstPendingInput(database, sessionId);
  return pending === undefined
    ? undefined
    : {
        content: pending.content,
        id: pending.id,
        images: parseStoredImages(
          pending.images,
          "Stored pending session images are invalid",
        ),
        sessionId: pending.sessionId,
      };
}

export function hasPendingSteeringInput(
  inputs: readonly AgentSessionPendingInput[],
): boolean {
  return inputs.some(({ kind }) => kind === "steer");
}

export function storedPendingInputs(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly AgentSessionPendingInput[] {
  return activeInputs(database, sessionId).map(storedPendingInput);
}

function validInputState(
  status: (typeof agentSessions.$inferSelect)["status"],
  kind: AgentSessionPendingInputKind,
): boolean {
  const acceptedStatuses =
    kind === "steer"
      ? (["running"] as const)
      : (["queued", "running"] as const);
  return acceptedStatuses.some((accepted) => status === accepted);
}

export interface SessionSystemWriteTarget {
  readonly database: Pick<AppDatabase, "insert" | "select" | "update">;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}

export function appendSystemFollowUp(
  options: SessionSystemWriteTarget & {
    readonly clientRequestId: string;
    readonly content: string;
    readonly kind: AgentSessionPendingInputKind;
  },
): boolean {
  const session = storedSessionForUser({
    database: options.database,
    sessionId: options.sessionId,
    userId: options.userId,
  });
  if (session?.status !== "running") {
    return false;
  }
  const id = options.generateId(options.now);
  insertPendingInput(options.database, {
    ...createdAuditFields(SYSTEM_ID, options.now),
    clientRequestId: options.clientRequestId,
    content: options.content,
    id,
    images: null,
    kind: options.kind,
    sequence: nextSequence(options.database, options.sessionId),
    sessionId: options.sessionId,
    userId: options.userId,
  });
  touchStoredSession(
    options.database,
    eq(agentSessions.id, options.sessionId),
    SYSTEM_ID,
    options.now,
  );
  if (options.kind === "steer") {
    notifySessionSteeringInput(options.sessionId);
  }
  return true;
}

function nextSequence(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): number {
  const previous =
    database
      .select({ sequence: max(agentPendingInputs.sequence) })
      .from(agentPendingInputs)
      .where(eq(agentPendingInputs.sessionId, sessionId))
      .get()?.sequence ?? 0;
  if (
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("The pending session input sequence is exhausted");
  }
  return previous + 1;
}

interface StoredSessionLookup {
  readonly database: Pick<AppDatabase, "select">;
  readonly sessionId: string;
  readonly userId?: string;
}

function storedSessionForUser({
  database,
  sessionId,
  userId,
}: StoredSessionLookup) {
  return storedActiveSessionState(database, sessionId, userId);
}

interface PendingInputOwnerOptions {
  readonly sessionId: string;
  readonly userId: string;
}

interface EnqueuePendingInputOptions extends PendingInputOwnerOptions {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly input: EnqueuePendingSessionInput;
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}

type PendingInputTransaction = Parameters<
  Parameters<AppDatabase["transaction"]>[0]
>[0];

function pendingInputSession(
  database: Pick<AppDatabase, "select">,
  options: PendingInputOwnerOptions,
) {
  return storedSessionForUser({
    database,
    sessionId: options.sessionId,
    userId: options.userId,
  });
}

function touchPendingSession(
  database: Pick<AppDatabase, "update">,
  options: Pick<EnqueuePendingInputOptions, "now" | "sessionId" | "userId">,
): void {
  touchStoredSession(
    database,
    eq(agentSessions.id, options.sessionId),
    options.userId,
    options.now,
  );
}

function enqueuePendingInputInTransaction(
  transaction: PendingInputTransaction,
  options: EnqueuePendingInputOptions,
): EnqueuePendingInputResult {
  const session = pendingInputSession(transaction, options);
  if (session === undefined) {
    return { status: "not_found" };
  }
  const duplicate = transaction
    .select(PENDING_SELECTION)
    .from(agentPendingInputs)
    .where(
      and(
        eq(agentPendingInputs.userId, options.userId),
        eq(agentPendingInputs.clientRequestId, options.input.clientRequestId),
      ),
    )
    .get();
  if (duplicate !== undefined) {
    return matchesDuplicate(duplicate, options.sessionId, options.input)
      ? { input: storedPendingInput(duplicate), status: "duplicate" }
      : { status: "conflict" };
  }
  if (!validInputState(session.status, options.input.kind)) {
    return { status: "invalid_state" };
  }

  const id = options.generateId(options.now);
  const values: typeof agentPendingInputs.$inferInsert = {
    ...createdAuditFields(options.userId, options.now),
    clientRequestId: options.input.clientRequestId,
    content: options.input.content,
    id,
    images: serializeStoredImages(options.input.images),
    kind: options.input.kind,
    sequence: nextSequence(transaction, options.sessionId),
    sessionId: options.sessionId,
    userId: options.userId,
  };
  insertPendingInput(transaction, values);
  touchPendingSession(transaction, options);
  return {
    input: {
      clientRequestId: options.input.clientRequestId,
      content: options.input.content,
      createdAt: options.now,
      id,
      images: options.input.images,
      kind: options.input.kind,
    },
    status: "accepted",
  };
}

export function enqueuePendingInput(
  options: EnqueuePendingInputOptions,
): EnqueuePendingInputResult {
  const result = options.database.transaction((transaction) =>
    enqueuePendingInputInTransaction(transaction, options),
  );
  if (result.status === "accepted" && result.input.kind === "steer") {
    notifySessionSteeringInput(options.sessionId);
  }
  return result;
}

export type CancelPendingInputResult =
  | {
      readonly input: AgentSessionPendingInput;
      readonly status: "already_cancelled" | "cancelled";
    }
  | { readonly status: "consumed" | "invalid_state" | "not_found" };

function pendingInputCondition(
  inputId: string,
  sessionId?: string,
  userId?: string,
) {
  return and(
    eq(agentPendingInputs.id, inputId),
    sessionId === undefined
      ? undefined
      : eq(agentPendingInputs.sessionId, sessionId),
    userId === undefined ? undefined : eq(agentPendingInputs.userId, userId),
  );
}

export function cancelPendingInput(options: {
  readonly database: AppDatabase;
  readonly inputId: string;
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}): CancelPendingInputResult {
  const result: CancelPendingInputResult = options.database.transaction(
    (database): CancelPendingInputResult => {
      const session = pendingInputSession(database, options);
      if (session === undefined) return { status: "not_found" };
      const stored = database
        .select(CANCELLABLE_PENDING_SELECTION)
        .from(agentPendingInputs)
        .where(
          pendingInputCondition(
            options.inputId,
            options.sessionId,
            options.userId,
          ),
        )
        .get();
      if (stored === undefined) {
        return { status: "not_found" };
      }
      if (stored.isDeleted) {
        const consumed = database
          .select({ id: agentMessages.id })
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.id, options.inputId),
              eq(agentMessages.sessionId, options.sessionId),
              eq(agentMessages.isDeleted, false),
            ),
          )
          .get();
        return consumed === undefined
          ? { input: storedPendingInput(stored), status: "already_cancelled" }
          : { status: "consumed" };
      }
      if (session.status !== "queued" && session.status !== "running") {
        return { status: "invalid_state" };
      }
      const input = storedPendingInput(stored);
      database
        .update(agentPendingInputs)
        .set(softDeletedAuditFields(options.userId, options.now))
        .where(
          and(
            pendingInputCondition(options.inputId),
            eq(agentPendingInputs.isDeleted, false),
          ),
        )
        .run();
      touchPendingSession(database, options);
      return { input, status: "cancelled" };
    },
  );
  return result;
}

function consumePendingInputWhere(
  database: Pick<AppDatabase, "update">,
  inputId: string,
  now: number,
  sessionId?: string,
) {
  return database
    .update(agentPendingInputs)
    .set(softDeletedAuditFields(SYSTEM_ID, now))
    .where(
      and(
        pendingInputCondition(inputId, sessionId),
        eq(agentPendingInputs.isDeleted, false),
      ),
    )
    .returning({ id: agentPendingInputs.id });
}

export function promotePendingInput(
  database: Pick<AppDatabase, "insert" | "select" | "update">,
  input: PendingInputForPromotion,
  userId: string,
  now: number,
  segment: number,
  turnId?: string,
): void {
  const messageNow = nextStoredMessageTimestamp(
    database,
    input.sessionId,
    segment,
    now,
  );
  database
    .insert(agentMessages)
    .values(
      userMessageValues({
        content: input.content,
        id: input.id,
        images: input.images,
        now: messageNow,
        segment,
        sessionId: input.sessionId,
        turnId: turnId ?? null,
        userId,
      }),
    )
    .run();
  consumePendingInputWhere(database, input.id, now).run();
}

function promoteInput(
  database: Pick<AppDatabase, "insert" | "select" | "update">,
  input: StoredPendingInput,
  userId: string,
  now: number,
  successorTurnId?: string,
): void {
  const segment = currentSessionSegment(database, input.sessionId);
  if (segment === undefined) {
    throw new Error("The agent session no longer exists");
  }
  const turnId =
    successorTurnId ?? activeSessionTurnId(database, input.sessionId);
  if (turnId === null) {
    throw new Error("The running session has no active turn");
  }
  promotePendingInput(
    database,
    {
      content: input.content,
      id: input.id,
      images: parseStoredImages(
        input.images,
        "Stored pending session images are invalid",
      ),
      sessionId: input.sessionId,
    },
    userId,
    now,
    segment,
    turnId,
  );
}

export function takeSteeringInputs(options: {
  readonly database: AppDatabase;
  readonly now: number;
  readonly sessionId: string;
}): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[] {
  return options.database.transaction((transaction) => {
    const session = storedSessionForUser({
      database: transaction,
      sessionId: options.sessionId,
    });
    if (session?.status !== "running") {
      return [];
    }
    const consumed: StoredPendingInput[] = [];
    for (const input of activeInputs(transaction, options.sessionId)) {
      if (input.kind !== "steer") {
        break;
      }
      promoteInput(transaction, input, session.userId, options.now);
      consumed.push(input);
    }
    return consumed.map((input) => {
      const attachments = parseStoredImages(
        input.images,
        "Stored pending session attachments are invalid",
      );
      return {
        content: input.content,
        ...(attachments.length === 0 ? {} : { attachments }),
        role: "user" as const,
      };
    });
  });
}

export type NormalSessionBoundaryResult =
  | { readonly status: "idle" | "missing" | "stopped" }
  | { readonly status: "queued" | "running"; readonly userId: string };

export function settleNormalSessionBoundary(options: {
  readonly database: AppDatabase;
  readonly generation: number;
  readonly now: number;
  readonly sessionId: string;
}): NormalSessionBoundaryResult {
  return options.database.transaction((transaction) => {
    const session = storedActiveSessionState(transaction, options.sessionId);

    if (session?.executionGeneration !== options.generation) {
      return { status: "missing" };
    }
    if (session.status === "stopped") {
      return { status: "stopped" };
    }
    if (session.status !== "running" || session.activeStartedAt === null) {
      return { status: "idle" };
    }

    const pending = firstPendingInput(transaction, options.sessionId);
    const queued = pending !== undefined;
    const successorTurnId = queued
      ? rotateSessionTurn({
          database: transaction,
          executionGeneration: options.generation,
          generateId: () => `${options.sessionId}:${String(options.now)}`,
          now: options.now,
          previousExecutionGeneration: options.generation,
          segment: session.currentSegment,
          sessionId: options.sessionId,
          toolSettings: "inherit",
          userId: session.userId,
        })
      : undefined;
    if (
      successorTurnId !== undefined &&
      (pending?.kind === "steer" || pending?.kind === "follow_up")
    ) {
      promoteInput(
        transaction,
        pending,
        session.userId,
        options.now,
        successorTurnId,
      );
    }
    const changed = transaction
      .update(agentSessions)
      .set({
        ...sessionTimingUpdate(session, options.now),
        interruptedHandoff: null,
        status: queued ? "queued" : "idle",
        updatedAt: new Date(options.now),
        updatedById: SYSTEM_ID,
      })
      .where(
        and(
          eq(agentSessions.id, options.sessionId),
          eq(agentSessions.executionGeneration, options.generation),
          eq(agentSessions.status, "running"),
        ),
      )
      .returning({ id: agentSessions.id })
      .all();
    if (changed.length === 0) {
      throw new Error("The running session changed at its terminal boundary");
    }
    retireManualCompactionOperations(
      transaction,
      options.sessionId,
      options.generation,
      options.now,
      "through",
    );
    if (!queued) {
      endGenerationSessionTurn(
        transaction,
        options.sessionId,
        options.generation,
        options.now,
      );
    }
    return queued
      ? { status: "queued", userId: session.userId }
      : { status: "idle" };
  });
}
