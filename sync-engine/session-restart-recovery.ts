import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { PendingRestartSession } from "./session-restart-store.ts";
import type { SessionStore } from "./session-store.ts";

interface RestartCredentialSelection {
  readonly credentialId: string;
  readonly provider: "openai" | "openrouter";
}

// cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
interface SessionRestartRecoveryDependencies {
  readonly credential: (
    userId: string,
    selection: RestartCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => boolean;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly runnerIsAvailable: (userId: string, runnerId: string) => boolean;
  readonly store: SessionStore;
}
// cpd-ignore-end

async function recoverOne(
  dependencies: SessionRestartRecoveryDependencies,
  pending: PendingRestartSession,
): Promise<void> {
  const credential = await dependencies.credential(
    pending.userId,
    pending.detail,
  );
  if (
    credential === undefined ||
    !dependencies.runnerIsAvailable(pending.userId, pending.detail.runnerId)
  ) {
    return;
  }
  const restartId = pending.detail.restartHandoff?.restartId;
  if (restartId === undefined) {
    return;
  }
  const claimed = dependencies.store.claimRestartHandoff(
    pending.userId,
    pending.detail.id,
    restartId,
    dependencies.now(),
  );
  if (claimed === undefined) {
    return;
  }
  if (!dependencies.launch(claimed, credential, pending.userId)) {
    dependencies.store.restoreRestartHandoff(claimed.id, dependencies.now());
    return;
  }
  dependencies.notify(pending.userId, pending.detail.id);
}

export function recoverSessionRestartHandoffs(
  dependencies: SessionRestartRecoveryDependencies,
  runnerId?: string,
): void {
  for (const pending of dependencies.store.pendingRestartHandoffs(runnerId)) {
    void recoverOne(dependencies, pending);
  }
}
