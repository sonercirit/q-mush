import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  RestartHandoff,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import { advanceStoredSessionGeneration } from "./session-generation-advance.ts";
import {
  canonicalRestartHandoff,
  parseRestartHandoff,
} from "./session-restart-store.ts";
import {
  activeSessionCondition,
  readStoredSessionSnapshots,
  sessionGenerationCondition,
  sessionTimingUpdate,
  updateStoredSessions,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";
import { appendUnknownRestartToolResults } from "./session-store-read.ts";

interface ShutdownInterruptedSessionStoreOptions {
  readonly database: AppDatabase;
  readonly generateId: (now: number) => string;
}

function shutdownHandoff(
  executionGeneration: number,
  restartId: string,
  operation: RestartHandoffOperation,
): RestartHandoff {
  return {
    executionGeneration,
    operation,
    pendingInput: [],
    requestedBy: "server",
    restartId,
  };
}

export interface ShutdownInterruptedSessionStore {
  readonly beginLiveDrain: () => void;
  readonly clear: (
    sessionId: string,
    generation: number,
    now: number,
  ) => boolean;
  readonly enableRecovery: () => void;
  readonly failInvalid: (now: number) => void;
  readonly mark: (
    sessionId: string,
    generation: number,
    restartId: string,
    operation: RestartHandoffOperation,
    now: number,
  ) => boolean;
  readonly recover: (now: () => number) => void;
  readonly recoveryEnabled: () => boolean;
  readonly restore: (now: number) => void;
}

export function ShutdownInterruptedSessionStore(
  options: ShutdownInterruptedSessionStoreOptions,
): ShutdownInterruptedSessionStore {
  let recoveryEnabled = true;

  function mark(
    sessionId: string,
    generation: number,
    restartId: string,
    operation: RestartHandoffOperation,
    now: number,
  ): boolean {
    const marker = shutdownHandoff(generation, restartId, operation);
    return updateStoredSessions(
      options.database,
      and(
        activeSessionCondition({ id: sessionId, status: "running" }),
        eq(agentSessions.executionGeneration, generation),
        isNull(agentSessions.restartHandoff),
        isNull(agentSessions.interruptedHandoff),
      ),
      {
        interruptedHandoff: canonicalRestartHandoff(marker),
        ...updatedAuditFields(SYSTEM_ID, now),
      },
    );
  }

  function clear(sessionId: string, generation: number, now: number): boolean {
    return updateStoredSessions(
      options.database,
      and(
        activeSessionCondition({ id: sessionId }),
        eq(agentSessions.executionGeneration, generation),
        isNotNull(agentSessions.interruptedHandoff),
      ),
      {
        interruptedHandoff: null,
        ...updatedAuditFields(SYSTEM_ID, now),
      },
    );
  }

  function beginLiveDrain(): void {
    recoveryEnabled = false;
  }

  function enableRecovery(): void {
    recoveryEnabled = true;
  }

  function isRecoveryEnabled(): boolean {
    return recoveryEnabled;
  }

  function markedSessions(): readonly StoredSessionSnapshot[] {
    return readStoredSessionSnapshots(
      options.database,
      and(
        activeSessionCondition({ status: "running" }),
        isNull(agentSessions.restartHandoff),
        isNotNull(agentSessions.interruptedHandoff),
      ),
    );
  }

  function exactCondition(session: StoredSessionSnapshot, raw: string) {
    return and(
      activeSessionCondition({
        id: session.id,
        status: "running",
        userId: session.userId,
      }),
      eq(agentSessions.executionGeneration, session.executionGeneration),
      eq(agentSessions.interruptedHandoff, raw),
      isNull(agentSessions.restartHandoff),
    );
  }

  function marker(session: StoredSessionSnapshot): RestartHandoff | undefined {
    const value = session.interruptedHandoff ?? "";
    const marker = parseRestartHandoff(value);
    return marker?.executionGeneration === session.executionGeneration
      ? marker
      : undefined;
  }

  function sessionMarker(
    session: StoredSessionSnapshot,
  ): { readonly marker: RestartHandoff; readonly raw: string } | undefined {
    const parsedMarker = marker(session);
    return parsedMarker === undefined || session.interruptedHandoff === null
      ? undefined
      : { marker: parsedMarker, raw: session.interruptedHandoff };
  }

  function recover(now: () => number): void {
    if (!recoveryEnabled || markedSessions().length === 0) {
      return;
    }
    const recoveredAt = now();
    failInvalid(recoveredAt);
    restore(recoveredAt);
  }

  function failInvalid(now: number): void {
    if (!recoveryEnabled) return;
    const invalid = markedSessions().filter((session) => {
      try {
        return marker(session) === undefined;
      } catch {
        return true;
      }
    });
    for (const session of invalid) {
      const raw = session.interruptedHandoff;
      if (raw === null) {
        continue;
      }
      updateStoredSessions(options.database, exactCondition(session, raw), {
        status: "paused",
        interruptedHandoff: null,
        restartHandoff: raw,
        ...sessionTimingUpdate(session, now),
        ...updatedAuditFields(SYSTEM_ID, now),
      });
    }
  }

  function restore(now: number): void {
    if (!recoveryEnabled) return;
    for (const session of markedSessions()) {
      const marked = sessionMarker(session);
      if (marked === undefined) {
        continue;
      }
      const { marker, raw } = marked;
      options.database.transaction((transaction) => {
        const advanced = advanceStoredSessionGeneration({
          condition: exactCondition(session, raw),
          database: transaction,
          generateId: options.generateId,
          mode: "attempt",
          now,
          sessionId: session.id,
          startTurn: {},
          values: {
            status: "paused",
            interruptedHandoff: null,
            ...sessionTimingUpdate(session, now),
            ...updatedAuditFields(SYSTEM_ID, now),
          },
        });
        if (advanced === undefined) return;
        const handoff = {
          ...marker,
          executionGeneration: advanced.generation,
        };
        updateStoredSessions(
          transaction,
          and(
            sessionGenerationCondition(
              {
                id: session.id,
                status: "paused",
                userId: session.userId,
              },
              advanced.generation,
            ),
            isNull(agentSessions.interruptedHandoff),
          ),
          { restartHandoff: canonicalRestartHandoff(handoff) },
        );
        appendUnknownRestartToolResults({
          database: transaction,
          generateId: options.generateId,
          now,
          sessionId: session.id,
        });
      });
    }
  }

  return {
    beginLiveDrain,
    clear,
    enableRecovery,
    failInvalid,
    mark,
    recover,
    recoveryEnabled: isRecoveryEnabled,
    restore,
  };
}
