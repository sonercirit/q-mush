import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

// cpd-ignore-start -- Dependency contracts remain local to each session orchestration boundary.
export interface QueuedSessionLauncherDependencies {
  readonly draining: () => boolean;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => boolean;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly readCredential: (
    userId: string,
    detail: AgentSessionDetail,
    action: (credential: ProviderCredentialAccess) => Response,
  ) => Promise<Response>;
  readonly runnerIsAvailable: (userId: string, runnerId: string) => boolean;
  readonly runtimes: Pick<SessionRuntimes, "active">;
  readonly store: SessionStore;
}
// cpd-ignore-end

export async function launchQueuedSessions(
  dependencies: QueuedSessionLauncherDependencies,
  userId: string,
): Promise<void> {
  for (const detail of dependencies.store.queuedSessions(userId)) {
    if (
      dependencies.draining() ||
      dependencies.runtimes.active(detail.id) ||
      !dependencies.runnerIsAvailable(userId, detail.runnerId)
    ) {
      continue;
    }
    await dependencies.readCredential(userId, detail, (credential) => {
      if (dependencies.launch(detail, credential, userId)) {
        dependencies.notify(userId, detail.id);
      }
      return new Response(null, { status: 204 });
    });
  }
}
