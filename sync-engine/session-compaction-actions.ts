import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { RealtimeCommandFailure } from "./realtime-command-ledger.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

interface ManualCompactionDependencies {
  readonly credential: (
    userId: string,
    detail: AgentSessionDetail,
    action: (credential: ProviderCredentialAccess) => Promise<void> | void,
  ) => Promise<void>;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => void;
  readonly runtimes: SessionRuntimes;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly store: SessionStore;
  readonly now: () => number;
}

export async function startManualSessionCompaction(
  dependencies: ManualCompactionDependencies,
  user: AuthenticatedUser,
  sessionId: string,
): Promise<AgentSessionDetail> {
  if (dependencies.runtimes.draining) {
    throw new RealtimeCommandFailure("server_restarting");
  }
  const existing = dependencies.store.get(user.id, sessionId);
  const status = existing?.status;
  if (existing === undefined) {
    throw new RealtimeCommandFailure("not_found");
  }
  if (status === "queued" || status === "running") {
    throw new RealtimeCommandFailure("session_busy");
  }

  let result: AgentSessionDetail | undefined;
  await dependencies.credential(user.id, existing, (credential) => {
    const queued = dependencies.store.queue(
      user.id,
      sessionId,
      dependencies.now(),
    );
    if (queued.status !== "queued") {
      throw new RealtimeCommandFailure("session_busy");
    }

    dependencies.launch(queued.detail, credential, user.id);
    queueMicrotask(() => {
      dependencies.notify(user.id, queued.detail.id);
    });
    result = queued.detail;
  });

  if (result === undefined) {
    throw new RealtimeCommandFailure("command_failed");
  }
  return result;
}
