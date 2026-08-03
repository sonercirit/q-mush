import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

interface InterruptedSessionRecoveryDependencies {
  readonly actions: Pick<SessionAgentActions, "reportAll">;
  readonly now: () => number;
  readonly runtimes?: Pick<SessionRuntimes, "activeForGeneration">;
  readonly store: Pick<SessionStore, "failInterrupted">;
}

interface PendingSpawnReportDependencies {
  readonly actions: Pick<SessionAgentActions, "reportAll">;
  readonly draining: () => boolean;
  readonly store: Pick<SessionStore, "pendingSpawnedSessions">;
}

export function reportPendingSpawns(
  dependencies: PendingSpawnReportDependencies,
): void {
  if (!dependencies.draining()) {
    dependencies.actions.reportAll(dependencies.store.pendingSpawnedSessions());
  }
}

export function recoverInterruptedSessions(
  dependencies: InterruptedSessionRecoveryDependencies,
  runnerId?: string,
): void {
  const matches = (detail: AgentSessionDetail): boolean =>
    runnerId === undefined
      ? detail.restartHandoff === null
      : detail.runnerId === runnerId;
  dependencies.actions.reportAll(
    dependencies.store
      .failInterrupted(
        dependencies.now(),
        dependencies.runtimes?.activeForGeneration.bind(dependencies.runtimes),
      )
      .filter(({ detail }) => matches(detail)),
  );
}
