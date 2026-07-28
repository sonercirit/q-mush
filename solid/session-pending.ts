import type { AgentSessionSummary } from "../shared/session-model.ts";
import type { SessionViewState } from "./session-client.tsx";

/** @public Maximum identities retained for uncertain creation reconciliation. */
export const MAXIMUM_CREATION_RECONCILIATION_IDENTITIES = 1_000;
const MAXIMUM_AGGREGATE_PENDING_COMMAND_BYTES = 128 * 1024 * 1024;

type PendingCommandSettlement = "reject" | "replay" | "settle" | "throw";

/** @public Returns the serialized byte cost used for command admission. */
export function pendingCommandPayloadBytes(payload: unknown): number {
  try {
    const serialized = JSON.stringify(payload);
    return typeof serialized === "string"
      ? new TextEncoder().encode(serialized).byteLength
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface PendingCommandReservation {
  readonly bytes: number;
  readonly userId: string;
  release(settlement: PendingCommandSettlement): void;
}

/** @public Aggregate command-capacity ledger. */
export class PendingCommandCapacity {
  #bytes = 0;
  readonly #maximumBytes: number;
  readonly #users = new Map<string, number>();

  constructor(maximumBytes = MAXIMUM_AGGREGATE_PENDING_COMMAND_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("Pending command byte capacity must be positive");
    }
    this.#maximumBytes = maximumBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  reserve(
    userId: string,
    bytes: number,
  ): PendingCommandReservation | undefined {
    if (
      userId.length === 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.#maximumBytes - this.#bytes
    ) {
      return undefined;
    }
    this.#users.set(userId, (this.#users.get(userId) ?? 0) + bytes);
    this.#bytes += bytes;
    let released = false;
    return {
      bytes,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#release(userId, bytes);
      },
      userId,
    };
  }

  #release(userId: string, bytes: number): void {
    const reserved = this.#users.get(userId);
    if (reserved === undefined || reserved < bytes || this.#bytes < bytes) {
      throw new Error("Pending command byte accounting was inconsistent");
    }
    const remaining = reserved - bytes;

    if (remaining === 0) {
      this.#users.delete(userId);
    } else {
      this.#users.set(userId, remaining);
    }
    this.#bytes -= bytes;
  }
}

const SESSION_COMMAND_CAPACITY = new PendingCommandCapacity();

export async function withPendingCommandCapacity<Value>(
  userId: string,
  payload: unknown,
  execute: () => Promise<Value>,
): Promise<Value> {
  const bytes = pendingCommandPayloadBytes(payload);
  const reservation = SESSION_COMMAND_CAPACITY.reserve(userId, bytes);
  if (reservation === undefined) {
    throw Object.assign(new Error("command_capacity_exceeded"), {
      code: "command_capacity_exceeded",
    });
  }
  try {
    const pending = execute();
    return await pending.then(
      (value) => {
        reservation.release("settle");
        return value;
      },
      (error: unknown) => {
        reservation.release("reject");
        throw error;
      },
    );
  } catch (error) {
    reservation.release("throw");
    throw error;
  }
}

export interface SessionCreationBaseline {
  readonly bounded: boolean;
  readonly ids: ReadonlySet<string>;
}

function newestSessionIdentities(
  sessions: readonly Pick<AgentSessionSummary, "id" | "updatedAt">[],
): readonly Pick<AgentSessionSummary, "id" | "updatedAt">[] {
  const retained = Array.from(sessions);
  retained.sort((left, right) => right.updatedAt - left.updatedAt);
  retained.length = Math.min(
    retained.length,
    MAXIMUM_CREATION_RECONCILIATION_IDENTITIES,
  );
  return retained;
}

/** @public Captures a bounded uncertain-creation baseline. */
export function cappedSessionCreationBaseline(
  sessions: readonly Pick<AgentSessionSummary, "id" | "updatedAt">[],
): SessionCreationBaseline {
  const retained = newestSessionIdentities(sessions);
  return {
    bounded: retained.length === sessions.length,
    ids: new Set(retained.map(({ id }) => id)),
  };
}

function sessionMutationBlocked(state: SessionViewState): boolean {
  return sessionMutationPending(state);
}

export function runUnlessSessionMutation<Value>(
  state: SessionViewState,
  operation: () => Value,
  blocked: Value,
): Value {
  return sessionMutationBlocked(state) ? blocked : operation();
}

export function cappedSessionCreationIds(
  ids: ReadonlySet<string>,
): SessionCreationBaseline {
  const retained = [...ids].slice(
    0,
    MAXIMUM_CREATION_RECONCILIATION_IDENTITIES,
  );
  return {
    bounded: retained.length === ids.size,
    ids: new Set(retained),
  };
}

function sessionDetailMutationPending(state: SessionViewState): boolean {
  return (
    state.answeringQuestions ||
    state.compacting ||
    state.forking ||
    state.reassigning ||
    state.sending ||
    state.stopping ||
    state.updatingTools
  );
}

export function sessionMutationPending(state: SessionViewState): boolean {
  return state.creating || sessionDetailMutationPending(state);
}
