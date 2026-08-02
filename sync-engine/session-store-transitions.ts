import { and, eq, type SQL } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";
import {
  readActiveSessionTiming,
  runningCondition,
  sessionGenerationCondition,
  sessionTimingUpdate,
  storedSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";
import { readStoredSessionState } from "./session-store-state.ts";
import type {
  SessionStatusTransition,
  SessionTransitionInput,
} from "./session-transition-types.ts";
import { optionalRestartHandoff } from "./session-transition-values.ts";
import {
  type SessionGenerationSettlement,
  updateSessionAndEndGenerationTurn,
} from "./session-turn-store.ts";

interface SessionRuntimeTransitionResources {
  readonly database: AppDatabase;
}

function transitionAndEndTurn(
  options: Omit<SessionGenerationSettlement, "generation"> & {
    readonly database: AppDatabase;
  },
): boolean {
  return options.database.transaction((transaction) => {
    const session = readStoredSessionState(transaction, options.condition);
    return (
      session !== undefined &&
      updateSessionAndEndGenerationTurn({
        ...options,
        database: transaction,
        generation: session.executionGeneration,
      })
    );
  });
}

type RuntimeStatusTransitionOptions = SessionTransitionInput & {
  readonly actorId?: string;
  readonly resources: SessionRuntimeTransitionResources;
  readonly status: AgentSessionStatus;
};

function transitionOptions(
  options: RuntimeStatusTransitionOptions,
  condition: SQL | undefined,
  values: Parameters<typeof updateStoredSessions>[2],
) {
  return {
    condition,
    database: options.resources.database,
    now: options.now,
    sessionId: options.sessionId,
    values,
  };
}

function transitionValues(
  options: RuntimeStatusTransitionOptions,
  additional: Parameters<typeof updateStoredSessions>[2] = {},
) {
  return {
    ...additional,
    interruptedHandoff: null,
    status: options.status,
    ...updatedAuditFields(options.actorId ?? SYSTEM_ID, options.now),
    ...optionalRestartHandoff(options.clearRestartHandoff),
  };
}

function finishActiveSession(options: RuntimeStatusTransitionOptions): boolean {
  const condition = runningCondition(
    options.sessionId,
    options.userId,
    options.generation,
  );
  const session = readActiveSessionTiming(
    options.resources.database,
    condition,
  );
  if (session === undefined) {
    return false;
  }
  return transitionAndEndTurn(
    transitionOptions(
      options,
      condition,
      transitionValues(options, sessionTimingUpdate(session, options.now)),
    ),
  );
}

export function transitionSessionRuntime(options: {
  readonly generation: number;
  readonly now: number;
  readonly resources: SessionRuntimeTransitionResources;
  readonly sessionId: string;
  readonly status: "failed" | "idle" | "running";
}): boolean {
  if (options.status === "running") {
    return updateStoredSessions(
      options.resources.database,
      sessionGenerationCondition(
        { id: options.sessionId, status: "queued" },
        options.generation,
      ),
      {
        activeStartedAt: new Date(options.now),
        interruptedHandoff: null,
        status: "running",
        ...updatedAuditFields(SYSTEM_ID, options.now),
      },
    );
  }
  if (options.status === "idle") {
    return finishActiveSession({ ...options, status: "idle" });
  }
  return (
    finishActiveSession({ ...options, status: "failed" }) ||
    systemTransition({
      ...options,
      from: ["queued"],
      status: "failed",
    })
  );
}

function systemTransition(
  options: RuntimeStatusTransitionOptions & SessionStatusTransition,
): boolean {
  const identity = storedSessionCondition({
    id: options.sessionId,
    status: options.from,
  });
  const condition: SQL | undefined = and(
    identity,
    options.generation === undefined
      ? undefined
      : eq(agentSessions.executionGeneration, options.generation),
    options.userId === undefined
      ? undefined
      : eq(agentSessions.userId, options.userId),
  );
  return transitionAndEndTurn(
    transitionOptions(options, condition, transitionValues(options)),
  );
}

export function stopStoredSession(options: {
  readonly now: number;
  readonly resources: SessionRuntimeTransitionResources;
  readonly sessionId: string;
  readonly userId: string;
}): boolean {
  return (
    finishActiveSession({
      actorId: options.userId,
      clearRestartHandoff: true,
      ...options,
      status: "stopped",
    }) ||
    systemTransition({
      actorId: options.userId,
      clearRestartHandoff: true,
      ...options,
      from: ["queued", "running", "paused", "idle", "failed"],
      status: "stopped",
    })
  );
}
