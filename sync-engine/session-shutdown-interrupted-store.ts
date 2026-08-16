import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  RestartHandoff,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import {
  canonicalRestartHandoff,
  parseRestartHandoff,
} from "./session-restart-store.ts";
import {
  activeSessionCondition,
  readStoredSessionSnapshots,
  sessionTimingUpdate,
  updateStoredSessions,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";
import { appendUnknownRestartToolResults } from "./session-store-read.ts";
import { rotateSessionTurn } from "./session-turn-store.ts";

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

export class ShutdownInterruptedSessionStore {
  readonly #options: ShutdownInterruptedSessionStoreOptions;
  #recoveryEnabled = true;

  constructor(options: ShutdownInterruptedSessionStoreOptions) {
    this.#options = options;
  }

  mark(
    sessionId: string,
    generation: number,
    restartId: string,
    operation: RestartHandoffOperation,
    now: number,
  ): boolean {
    const marker = shutdownHandoff(generation, restartId, operation);
    return updateStoredSessions(
      this.#options.database,
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

  clear(sessionId: string, generation: number, now: number): boolean {
    return updateStoredSessions(
      this.#options.database,
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

  beginLiveDrain(): void {
    this.#recoveryEnabled = false;
  }

  enableRecovery(): void {
    this.#recoveryEnabled = true;
  }

  recoveryEnabled(): boolean {
    return this.#recoveryEnabled;
  }

  #markedSessions(): readonly StoredSessionSnapshot[] {
    return readStoredSessionSnapshots(
      this.#options.database,
      and(
        activeSessionCondition({ status: "running" }),
        isNull(agentSessions.restartHandoff),
        isNotNull(agentSessions.interruptedHandoff),
      ),
    );
  }

  #exactCondition(session: StoredSessionSnapshot, raw: string) {
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

  #marker(session: StoredSessionSnapshot): RestartHandoff | undefined {
    const value = session.interruptedHandoff ?? "";
    const marker = parseRestartHandoff(value);
    return marker?.executionGeneration === session.executionGeneration
      ? marker
      : undefined;
  }

  #sessionMarker(
    session: StoredSessionSnapshot,
  ): { readonly marker: RestartHandoff; readonly raw: string } | undefined {
    const marker = this.#marker(session);
    return marker === undefined || session.interruptedHandoff === null
      ? undefined
      : { marker, raw: session.interruptedHandoff };
  }

  recover(now: () => number): void {
    if (!this.#recoveryEnabled || this.#markedSessions().length === 0) {
      return;
    }
    const recoveredAt = now();
    this.failInvalid(recoveredAt);
    this.restore(recoveredAt);
  }

  failInvalid(now: number): void {
    if (!this.#recoveryEnabled) return;
    const invalid = this.#markedSessions().filter((session) => {
      try {
        return this.#marker(session) === undefined;
      } catch {
        return true;
      }
    });
    for (const session of invalid) {
      const raw = session.interruptedHandoff;
      if (raw === null) {
        continue;
      }
      updateStoredSessions(
        this.#options.database,
        this.#exactCondition(session, raw),
        {
          status: "paused",
          interruptedHandoff: null,
          restartHandoff: raw,
          ...sessionTimingUpdate(session, now),
          ...updatedAuditFields(SYSTEM_ID, now),
        },
      );
    }
  }

  restore(now: number): void {
    if (!this.#recoveryEnabled) return;
    for (const session of this.#markedSessions()) {
      const marked = this.#sessionMarker(session);
      if (marked === undefined) {
        continue;
      }
      const { marker, raw } = marked;
      const handoff = {
        ...marker,
        executionGeneration: session.executionGeneration + 1,
      };
      this.#options.database.transaction((transaction) => {
        const changed = updateStoredSessions(
          transaction,
          this.#exactCondition(session, raw),
          {
            status: "paused",
            restartHandoff: canonicalRestartHandoff(handoff),
            interruptedHandoff: null,
            ...sessionTimingUpdate(session, now),
            executionGeneration: handoff.executionGeneration,
            ...updatedAuditFields(SYSTEM_ID, now),
          },
        );
        if (!changed) {
          return;
        }
        retireManualCompactionOperations(
          transaction,
          session.id,
          session.executionGeneration,
          now,
          "through",
        );
        const segment =
          transaction.query.agentSessions
            .findFirst({
              columns: { currentSegment: true },
              where: eq(agentSessions.id, session.id),
            })
            .sync()?.currentSegment ?? 0;
        rotateSessionTurn({
          database: transaction,
          executionGeneration: handoff.executionGeneration,
          generateId: this.#options.generateId,
          now,
          previousExecutionGeneration: session.executionGeneration,
          segment,
          sessionId: session.id,
          userId: session.userId,
        });
        appendUnknownRestartToolResults({
          database: transaction,
          generateId: this.#options.generateId,
          now,
          sessionId: session.id,
        });
      });
    }
  }
}
