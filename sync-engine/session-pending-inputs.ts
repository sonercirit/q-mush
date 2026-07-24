import { and, asc, eq } from "drizzle-orm";
import { readAgentImages, type AgentImage } from "../shared/agent-images.ts";
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
import { userMessageValues } from "./session-store-values.ts";

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
  readonly sessionId: string;
}

function parseImages(value: string | null): readonly AgentImage[] {
  // cpd-ignore-start -- Pending images use the same serialized format as transcript images.
  if (value === null) {
    return [];
  }
  const parsed: unknown = JSON.parse(value);
  const images = readAgentImages(parsed);
  if (images === undefined) {
    throw new Error("Stored pending session images are invalid");
  }
  return images;
  // cpd-ignore-end
}

function storedPendingInput(
  stored: StoredPendingInput,
): AgentSessionPendingInput {
  return {
    content: stored.content,
    createdAt: stored.createdAt.getTime(),
    id: stored.id,
    images: parseImages(stored.images),
    kind: stored.kind,
  };
}

function pendingSelection() {
  return {
    clientRequestId: agentPendingInputs.clientRequestId,
    content: agentPendingInputs.content,
    createdAt: agentPendingInputs.createdAt,
    id: agentPendingInputs.id,
    images: agentPendingInputs.images,
    kind: agentPendingInputs.kind,
    sessionId: agentPendingInputs.sessionId,
  };
}

function serializedImages(images: readonly AgentImage[]): string | null {
  return images.length === 0 ? null : JSON.stringify(images);
}

function matchesDuplicate(
  stored: StoredPendingInput,
  sessionId: string,
  input: EnqueuePendingSessionInput,
): boolean {
  return (
    stored.sessionId === sessionId &&
    stored.kind === input.kind &&
    stored.content === input.content &&
    stored.images === serializedImages(input.images)
  );
}

function pendingCondition(sessionId: string) {
  return and(
    eq(agentPendingInputs.sessionId, sessionId),
    eq(agentPendingInputs.isDeleted, false),
  );
}

export function storedPendingInputs(
  database: AppDatabase,
  sessionId: string,
): readonly AgentSessionPendingInput[] {
  return database
    .select(pendingSelection())
    .from(agentPendingInputs)
    .where(pendingCondition(sessionId))
    .orderBy(asc(agentPendingInputs.createdAt), asc(agentPendingInputs.id))
    .all()
    .map(storedPendingInput);
}

// cpd-ignore-start -- Transactional SQLite selection and updates intentionally mirror adjacent store operations.
export function enqueuePendingInput(options: {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly input: EnqueuePendingSessionInput;
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}): EnqueuePendingInputResult {
  return options.database.transaction((transaction) => {
    const duplicate = transaction
      .select(pendingSelection())
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

    const session = transaction
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, options.sessionId),
          eq(agentSessions.userId, options.userId),
          eq(agentSessions.isDeleted, false),
        ),
      )
      .get();
    if (session === undefined) {
      return { status: "not_found" };
    }
    const valid =
      options.input.kind === "steer"
        ? session.status === "running"
        : session.status === "running" || session.status === "queued";
    if (!valid) {
      return { status: "invalid_state" };
    }

    const pending = transaction
      .select({ id: agentPendingInputs.id })
      .from(agentPendingInputs)
      .where(pendingCondition(options.sessionId))
      .all();
    if (pending.length >= MAXIMUM_PENDING_SESSION_INPUTS) {
      return { status: "full" };
    }

    const id = options.generateId(options.now);
    transaction
      .insert(agentPendingInputs)
      .values({
        ...createdAuditFields(options.userId, options.now),
        clientRequestId: options.input.clientRequestId,
        content: options.input.content,
        id,
        images: serializedImages(options.input.images),
        kind: options.input.kind,
        sessionId: options.sessionId,
        userId: options.userId,
      })
      .run();
    transaction
      .update(agentSessions)
      .set({ updatedAt: new Date(options.now), updatedById: options.userId })
      .where(eq(agentSessions.id, options.sessionId))
      .run();
    return {
      input: {
        content: options.input.content,
        createdAt: options.now,
        id,
        images: options.input.images,
        kind: options.input.kind,
      },
      status: "accepted",
    };
  });
}
// cpd-ignore-end

function insertAndConsume(
  database: Pick<AppDatabase, "insert" | "update">,
  sessionId: string,
  stored: StoredPendingInput,
  userId: string,
  now: number,
): void {
  database
    .insert(agentMessages)
    .values(
      userMessageValues({
        content: stored.content,
        id: stored.id,
        images: parseImages(stored.images),
        now,
        sessionId,
        userId,
      }),
    )
    .run();
  database
    .update(agentPendingInputs)
    .set(softDeletedAuditFields(SYSTEM_ID, now))
    .where(eq(agentPendingInputs.id, stored.id))
    .run();
}

// cpd-ignore-start -- Both consumers use the same transactional queue ordering and session guard.
export function takeSteeringInputs(options: {
  readonly database: AppDatabase;
  readonly now: number;
  readonly sessionId: string;
}): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[] {
  return options.database.transaction((transaction) => {
    const session = transaction
      .select({ status: agentSessions.status, userId: agentSessions.userId })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, options.sessionId),
          eq(agentSessions.isDeleted, false),
        ),
      )
      .get();
    if (session?.status !== "running") {
      return [];
    }
    const consumed: StoredPendingInput[] = [];
    for (const input of transaction
      .select(pendingSelection())
      .from(agentPendingInputs)
      .where(pendingCondition(options.sessionId))
      .orderBy(asc(agentPendingInputs.createdAt), asc(agentPendingInputs.id))
      .all()) {
      if (input.kind !== "steer") {
        break;
      }
      insertAndConsume(
        transaction,
        options.sessionId,
        input,
        session.userId,
        options.now,
      );
      consumed.push(input);
    }
    return consumed.map((input) => {
      const images = parseImages(input.images);
      return {
        content: input.content,
        ...(images.length === 0 ? {} : { images }),
        role: "user" as const,
      };
    });
  });
}
// cpd-ignore-end

export type NormalSessionBoundaryResult =
  | { readonly status: "idle" | "missing" | "stopped" }
  | { readonly status: "queued" | "running"; readonly userId: string };

// cpd-ignore-start -- Both consumers use the same transactional queue ordering and session guard.
export function settleNormalSessionBoundary(options: {
  readonly database: AppDatabase;
  readonly now: number;
  readonly sessionId: string;
}): NormalSessionBoundaryResult {
  return options.database.transaction((transaction) => {
    const session = transaction
      .select({
        activeDurationMs: agentSessions.activeDurationMs,
        activeStartedAt: agentSessions.activeStartedAt,
        status: agentSessions.status,
        userId: agentSessions.userId,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, options.sessionId),
          eq(agentSessions.isDeleted, false),
        ),
      )
      .get();
    if (session === undefined) {
      return { status: "missing" };
    }
    if (session.status !== "running" || session.activeStartedAt === null) {
      return {
        status: session.status === "stopped" ? "stopped" : "idle",
      };
    }

    const pending = transaction
      .select(pendingSelection())
      .from(agentPendingInputs)
      .where(pendingCondition(options.sessionId))
      .orderBy(asc(agentPendingInputs.createdAt), asc(agentPendingInputs.id))
      .get();
    if (pending?.kind === "steer") {
      return { status: "running", userId: session.userId };
    }

    const followUp = pending?.kind === "follow_up" ? pending : undefined;
    if (followUp !== undefined) {
      insertAndConsume(
        transaction,
        options.sessionId,
        followUp,
        session.userId,
        options.now,
      );
    }
    transaction
      .update(agentSessions)
      .set({
        activeDurationMs: activeSessionDuration(session, options.now),
        activeStartedAt: null,
        status: followUp === undefined ? "idle" : "queued",
        updatedAt: new Date(options.now),
        updatedById: SYSTEM_ID,
      })
      .where(
        and(
          eq(agentSessions.id, options.sessionId),
          eq(agentSessions.status, "running"),
        ),
      )
      .run();
    return followUp === undefined
      ? { status: "idle" }
      : { status: "queued", userId: session.userId };
  });
}
// cpd-ignore-end
