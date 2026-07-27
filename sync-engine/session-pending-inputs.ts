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
import { activeSessionDuration } from "../shared/session-timing.ts";
import { storedActiveSessionState } from "./session-active-query.ts";
import { currentSessionSegment } from "./session-segment.ts";
import type { StoredUserMessageInput } from "./session-store-types.ts";
import { userMessageValues } from "./session-store-values.ts";
import { touchStoredSession } from "./session-touch.ts";
import {
  parseStoredImages,
  serializeStoredImages,
} from "./stored-agent-images.ts";

const MAXIMUM_PENDING_SESSION_INPUTS = 8;

export interface EnqueuePendingSessionInput {
  readonly clientRequestId: string;
  readonly content: string;
  readonly images: readonly AgentImage[];
  readonly kind: AgentSessionPendingInputKind;
}

export type EnqueuePendingInputResult =
  | { readonly input: AgentSessionPendingInput; readonly status: "accepted" }
  | { readonly input: AgentSessionPendingInput; readonly status: "duplicate" }
  | {
      readonly status: "conflict" | "full" | "invalid_state" | "not_found";
    };

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
  return {
    clientRequestId: stored.clientRequestId,
    content: stored.content,
    createdAt: stored.createdAt.getTime(),
    id: stored.id,
    images: parseStoredImages(
      stored.images,
      "Stored pending session images are invalid",
    ),
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

function pendingCondition(sessionId: string) {
  return and(
    eq(agentPendingInputs.sessionId, sessionId),
    eq(agentPendingInputs.isDeleted, false),
  );
}

function activeInputs(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly StoredPendingInput[] {
  return database
    .select(PENDING_SELECTION)
    .from(agentPendingInputs)
    .where(pendingCondition(sessionId))
    .orderBy(asc(agentPendingInputs.sequence))
    .all();
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
  const pending = activeInputs(database, sessionId)[0];
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

interface EnqueuePendingInputOptions {
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

function enqueuePendingInputInTransaction(
  transaction: PendingInputTransaction,
  options: EnqueuePendingInputOptions,
): EnqueuePendingInputResult {
  const session = storedSessionForUser({
    database: transaction,
    sessionId: options.sessionId,
    userId: options.userId,
  });
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
  if (
    activeInputs(transaction, options.sessionId).length >=
    MAXIMUM_PENDING_SESSION_INPUTS
  ) {
    return { status: "full" };
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
  transaction.insert(agentPendingInputs).values(values).run();
  touchStoredSession(
    transaction,
    eq(agentSessions.id, options.sessionId),
    options.userId,
    options.now,
  );
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
  return options.database.transaction((transaction) =>
    enqueuePendingInputInTransaction(transaction, options),
  );
}

export function promotePendingInput(
  database: Pick<AppDatabase, "insert" | "update">,
  input: PendingInputForPromotion,
  userId: string,
  now: number,
  segment: number,
): void {
  database
    .insert(agentMessages)
    .values(
      userMessageValues({
        content: input.content,
        id: input.id,
        images: input.images,
        now,
        segment,
        sessionId: input.sessionId,
        userId,
      }),
    )
    .run();
  database
    .update(agentPendingInputs)
    .set(softDeletedAuditFields(SYSTEM_ID, now))
    .where(
      and(
        eq(agentPendingInputs.id, input.id),
        eq(agentPendingInputs.isDeleted, false),
      ),
    )
    .run();
}

function promoteInput(
  database: Pick<AppDatabase, "insert" | "select" | "update">,
  input: StoredPendingInput,
  userId: string,
  now: number,
): void {
  const segment = currentSessionSegment(database, input.sessionId);
  if (segment === undefined) {
    throw new Error("The agent session no longer exists");
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
      const images = parseStoredImages(
        input.images,
        "Stored pending session images are invalid",
      );
      return {
        content: input.content,
        ...(images.length === 0 ? {} : { images }),
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

    const pending = activeInputs(transaction, options.sessionId)[0];
    if (pending?.kind === "steer" || pending?.kind === "follow_up") {
      promoteInput(transaction, pending, session.userId, options.now);
    }
    const queued = pending !== undefined;
    const changed = transaction
      .update(agentSessions)
      .set({
        activeDurationMs: activeSessionDuration(session, options.now),
        activeStartedAt: null,
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
    return queued
      ? { status: "queued", userId: session.userId }
      : { status: "idle" };
  });
}
