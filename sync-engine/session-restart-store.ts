import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  RestartHandoff,
  RestartHandoffOperation,
  RestartHandoffRequester,
} from "../shared/session-model.ts";
import { readNonNegativeSafeInteger } from "../shared/validation.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import { restartHandoffValues } from "./session-restart-handoff.ts";
import { runnerSessionCondition } from "./session-runner-condition.ts";
import {
  activeSessionCondition,
  readActiveSessionTiming,
  sessionTimingUpdate,
  storedSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";
import type { InterruptedStoredSession } from "./session-store-reassignment.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import { errorMessageValues } from "./session-store-values.ts";

export type {
  RestartHandoff,
  RestartHandoffRequester,
} from "../shared/session-model.ts";

export interface PendingRestartSession {
  readonly detail: AgentSessionDetail & {
    readonly restartHandoff: RestartHandoff | null;
  };
  readonly handoff: RestartHandoff;
  readonly userId: string;
}

export interface RestartHandoffIdentity extends SessionExecutionAuthority {
  readonly restartId: string;
}

export type RestartHandoffSettlement =
  | { readonly status: "idle" }
  | { readonly error: string; readonly status: "failed" };

type RestartHandoffStoreOptions = SessionStoreWriteResources & {
  readonly interruptUnknownTools?: (
    database: Pick<AppDatabase, "insert" | "select" | "update">,
    sessionId: string,
    now: number,
  ) => void;
};

type RestartStatus = Extract<
  AgentSessionStatus,
  "failed" | "idle" | "paused" | "queued" | "running"
>;

type RestartPauseArguments = [
  SessionExecutionAuthority,
  RestartHandoffRequester,
  string,
  RestartHandoffOperation,
  number,
];

interface PauseRestartHandoff {
  readonly authority: SessionExecutionAuthority;
  readonly now: number;
  readonly operation: RestartHandoffOperation;
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}

interface ExactRestartHandoff {
  readonly identity: RestartHandoffIdentity;
  readonly value: string;
}

function validRestartId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 200
  );
}

function exactHandoffShape(value: object): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === 5 &&
    keys[0] === "executionGeneration" &&
    keys[1] === "operation" &&
    keys[2] === "pendingInput" &&
    keys[3] === "requestedBy" &&
    keys[4] === "restartId"
  );
}

function isRestartHandoff(value: unknown): value is RestartHandoff {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactHandoffShape(value)
  ) {
    return false;
  }
  return (
    "executionGeneration" in value &&
    typeof value.executionGeneration === "number" &&
    readNonNegativeSafeInteger(value.executionGeneration) !== undefined &&
    "operation" in value &&
    (value.operation === "agent" ||
      value.operation === "compact" ||
      value.operation === "compact_and_continue") &&
    "pendingInput" in value &&
    Array.isArray(value.pendingInput) &&
    value.pendingInput.length === 0 &&
    "requestedBy" in value &&
    (value.requestedBy === "runner" || value.requestedBy === "server") &&
    "restartId" in value &&
    validRestartId(value.restartId)
  );
}

export function canonicalRestartHandoff(handoff: RestartHandoff): string {
  return JSON.stringify(restartHandoffValues(handoff));
}

export function parseRestartHandoff(
  value: string | null,
): RestartHandoff | null {
  if (value === null) {
    return null;
  }
  try {
    const handoff: unknown = JSON.parse(value);
    if (isRestartHandoff(handoff)) {
      return restartHandoffValues(handoff);
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored restart handoff is invalid");
}

function handoffValue(options: {
  readonly executionGeneration: number;
  readonly operation: RestartHandoffOperation;
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}): string {
  if (readNonNegativeSafeInteger(options.executionGeneration) === undefined) {
    throw new Error("The restart handoff generation is invalid");
  }
  if (!validRestartId(options.restartId)) {
    throw new Error("The restart handoff ID is invalid");
  }
  return JSON.stringify({
    executionGeneration: options.executionGeneration,
    operation: options.operation,
    pendingInput: [],
    requestedBy: options.requestedBy,
    restartId: options.restartId,
  } satisfies RestartHandoff);
}

function restartIdentityCondition(
  identity: SessionExecutionAuthority,
  status: RestartStatus,
  userId?: string,
): SQL | undefined {
  return storedSessionCondition({
    generation: identity.generation,
    id: identity.sessionId,
    status,
    userId,
  });
}

function restartSessionCondition(options: {
  readonly generation: number;
  readonly sessionId: string;
  readonly status: RestartStatus;
  readonly userId?: string;
}): SQL | undefined {
  return restartIdentityCondition(options, options.status, options.userId);
}

function readExactHandoff(
  database: Pick<AppDatabase, "select">,
  userId: string | undefined,
  identity: RestartHandoffIdentity,
  status: RestartStatus,
): ExactRestartHandoff | undefined {
  const stored = database
    .select({
      executionGeneration: agentSessions.executionGeneration,
      restartHandoff: agentSessions.restartHandoff,
    })
    .from(agentSessions)
    .where(restartIdentityCondition(identity, status, userId))
    .get();
  if (stored?.restartHandoff === null || stored === undefined) {
    return undefined;
  }
  const handoff = parseRestartHandoff(stored.restartHandoff);
  return handoff?.executionGeneration === identity.generation &&
    handoff.restartId === identity.restartId
    ? { identity, value: stored.restartHandoff }
    : undefined;
}

function exactHandoffCondition(
  exact: ExactRestartHandoff,
  status: RestartStatus,
  userId?: string,
): SQL | undefined {
  return and(
    restartIdentityCondition(exact.identity, status, userId),
    eq(agentSessions.restartHandoff, exact.value),
  );
}

export class RestartHandoffStore {
  readonly #options: RestartHandoffStoreOptions;

  constructor(options: RestartHandoffStoreOptions) {
    this.#options = options;
  }

  parse(value: string | null): RestartHandoff | null {
    return parseRestartHandoff(value);
  }

  #pauseValues(options: PauseRestartHandoff, handoffGeneration: number) {
    return {
      executionGeneration: handoffGeneration,
      restartHandoff: handoffValue({
        executionGeneration: handoffGeneration,
        operation: options.operation,
        requestedBy: options.requestedBy,
        restartId: options.restartId,
      }),
      status: "paused" as const,
      ...updatedAuditFields(SYSTEM_ID, options.now),
    };
  }

  #updateTimedSession(
    transaction: Pick<AppDatabase, "select" | "update">,
    condition: ReturnType<typeof and>,
    now: number,
    values: Parameters<typeof updateStoredSessions>[2],
  ): boolean {
    const session = readActiveSessionTiming(transaction, condition);
    return (
      session !== undefined &&
      updateStoredSessions(transaction, condition, {
        ...sessionTimingUpdate(session, now),
        ...values,
      })
    );
  }

  #pause(options: PauseRestartHandoff, from: "queued" | "running"): boolean {
    const handoffGeneration = options.authority.generation + 1;
    if (readNonNegativeSafeInteger(handoffGeneration) === undefined) {
      return false;
    }
    const condition = restartSessionCondition({
      generation: options.authority.generation,
      sessionId: options.authority.sessionId,
      status: from,
    });
    if (from === "queued") {
      return updateStoredSessions(
        this.#options.database,
        condition,
        this.#pauseValues(options, handoffGeneration),
      );
    }
    return this.#options.database.transaction((transaction) => {
      if (
        !this.#updateTimedSession(
          transaction,
          condition,
          options.now,
          this.#pauseValues(options, handoffGeneration),
        )
      ) {
        return false;
      }
      this.#options.interruptUnknownTools?.(
        transaction,
        options.authority.sessionId,
        options.now,
      );
      return true;
    });
  }

  pauseQueued(...arguments_: RestartPauseArguments): boolean {
    const [authority, requestedBy, restartId, operation, now] = arguments_;
    return this.#pause(
      { authority, now, operation, requestedBy, restartId },
      "queued",
    );
  }

  pauseRunning(...arguments_: RestartPauseArguments): boolean {
    return this.#pause(
      {
        authority: arguments_[0],
        now: arguments_[4],
        operation: arguments_[3],
        requestedBy: arguments_[1],
        restartId: arguments_[2],
      },
      "running",
    );
  }

  pending(runnerId?: string): readonly PendingRestartSession[] {
    return this.#options.database
      .select({
        executionGeneration: agentSessions.executionGeneration,
        id: agentSessions.id,
        restartHandoff: agentSessions.restartHandoff,
        userId: agentSessions.userId,
      })
      .from(agentSessions)
      .where(
        and(
          activeSessionCondition({ status: "paused" }),
          isNotNull(agentSessions.restartHandoff),
          runnerSessionCondition(runnerId),
        ),
      )
      .all()
      .flatMap(({ executionGeneration, id, restartHandoff, userId }) => {
        const handoff = parseRestartHandoff(restartHandoff);
        const current = this.#options.read(userId, id);
        const detail =
          current === undefined
            ? undefined
            : { ...current, restartHandoff: handoff };
        return handoff?.executionGeneration !== executionGeneration ||
          detail === undefined
          ? []
          : [{ detail, handoff, userId }];
      });
  }

  #withExactHandoff<T>(
    userId: string | undefined,
    identity: RestartHandoffIdentity,
    status: RestartStatus,
    operation: (
      transaction: Pick<AppDatabase, "insert" | "select" | "update">,
      exact: ExactRestartHandoff,
    ) => T | undefined,
  ): T | undefined {
    return this.#options.database.transaction((transaction) => {
      const exact = readExactHandoff(transaction, userId, identity, status);
      return exact === undefined ? undefined : operation(transaction, exact);
    });
  }

  claim(
    userId: string,
    identity: RestartHandoffIdentity,
    now: number,
  ): AgentSessionDetail | undefined {
    const claimed = this.#withExactHandoff(
      userId,
      identity,
      "paused",
      (transaction, exact) => {
        const updated = updateStoredSessions(
          transaction,
          exactHandoffCondition(exact, "paused", userId),
          { status: "queued", ...updatedAuditFields(SYSTEM_ID, now) },
        );
        return updated ? exact : undefined;
      },
    );
    const current = this.#options.read(userId, identity.sessionId);
    return claimed !== undefined && current !== undefined
      ? {
          ...current,
          restartHandoff: parseRestartHandoff(claimed.value),
        }
      : undefined;
  }

  restoreInterrupted(session: InterruptedStoredSession, now: number): boolean {
    const value = session.restartHandoff;
    const handoff = parseRestartHandoff(value);
    if (
      handoff?.executionGeneration !== session.executionGeneration ||
      value === null
    ) {
      return false;
    }
    const exact = {
      identity: {
        generation: session.executionGeneration,
        restartId: handoff.restartId,
        sessionId: session.id,
      },
      value,
    } satisfies ExactRestartHandoff;
    const restored = this.#options.database.transaction((transaction) => {
      const updated = updateStoredSessions(
        transaction,
        exactHandoffCondition(exact, session.status),
        {
          ...sessionTimingUpdate(session, now),
          status: "paused",
          ...updatedAuditFields(SYSTEM_ID, now),
        },
      );
      if (updated) {
        this.#options.interruptUnknownTools?.(transaction, session.id, now);
      }
      return updated;
    });
    return restored;
  }

  settle(
    userId: string,
    identity: RestartHandoffIdentity,
    settlement: RestartHandoffSettlement,
    now: number,
  ): boolean {
    return (
      this.#withExactHandoff(
        userId,
        identity,
        "running",
        (transaction, exact) => {
          const condition = exactHandoffCondition(exact, "running", userId);

          if (
            !this.#updateTimedSession(transaction, condition, now, {
              restartHandoff: null,
              status: settlement.status,
              ...updatedAuditFields(SYSTEM_ID, now),
            })
          ) {
            return false;
          }
          if (settlement.status === "failed") {
            const message = errorMessageValues(settlement.error);
            transaction
              .insert(agentMessages)
              .values({
                ...createdAuditFields(SYSTEM_ID, now),
                ...message,
                id: this.#options.generateId(now),
                segment: sql<number>`(SELECT ${agentSessions.currentSegment} FROM ${agentSessions} WHERE ${agentSessions.id} = ${identity.sessionId})`,
                sessionId: identity.sessionId,
                userId,
              })
              .run();
          }
          return true;
        },
      ) ?? false
    );
  }

  restore(identity: RestartHandoffIdentity, now: number): boolean {
    return (
      this.#withExactHandoff(
        undefined,
        identity,
        "queued",
        (transaction, exact) =>
          updateStoredSessions(
            transaction,
            exactHandoffCondition(exact, "queued"),
            { status: "paused", ...updatedAuditFields(SYSTEM_ID, now) },
          ),
      ) ?? false
    );
  }
}
