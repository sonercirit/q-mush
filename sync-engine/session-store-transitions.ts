import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import {
  readActiveSessionTiming,
  runningCondition,
  sessionGenerationCondition,
  sessionTimingUpdate,
  updateStoredSessions,
} from "./session-store-persistence.ts";
import { transitionStoredSession } from "./session-store-reassignment.ts";
import type {
  SessionStatusTransition,
  SessionTransitionInput,
} from "./session-transition-types.ts";
import { optionalRestartHandoff } from "./session-transition-values.ts";

interface SessionRuntimeTransitionResources {
  readonly database: AppDatabase;
}

function finishActiveSession(
  options: SessionTransitionInput & {
    readonly actorId?: string;
    readonly resources: SessionRuntimeTransitionResources;
    readonly status: "failed" | "idle" | "stopped";
  },
): boolean {
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
  return updateStoredSessions(options.resources.database, condition, {
    ...sessionTimingUpdate(session, options.now),
    ...optionalRestartHandoff(options.clearRestartHandoff),
    status: options.status,
    ...updatedAuditFields(options.actorId ?? SYSTEM_ID, options.now),
  });
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
  options: SessionStatusTransition & {
    readonly resources: SessionRuntimeTransitionResources;
  },
): boolean {
  return transitionStoredSession({
    actorId: SYSTEM_ID,
    database: options.resources.database,
    from: options.from,
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
    now: options.now,
    sessionId: options.sessionId,
    to: options.status,
  });
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
    transitionStoredSession({
      actorId: options.userId,
      clearRestartHandoff: true,
      database: options.resources.database,
      from: ["queued", "running", "paused", "idle", "failed"],
      now: options.now,
      sessionId: options.sessionId,
      to: "stopped",
      userId: options.userId,
    })
  );
}
