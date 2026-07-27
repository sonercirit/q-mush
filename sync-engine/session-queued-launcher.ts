import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionRunnerIsAvailable,
  type SessionRunnerAvailability,
} from "./session-runner-availability.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

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
    action: (credential: ProviderCredentialAccess) => void,
  ) => Promise<void> | void;
  readonly runnerIsAvailable: SessionRunnerAvailability;
  readonly runtimes: Pick<SessionRuntimes, "active">;
  readonly store: Pick<SessionStore, "queuedSessions">;
}

export async function launchQueuedSessions(
  dependencies: QueuedSessionLauncherDependencies,
  userId: string,
): Promise<void> {
  for (const detail of dependencies.store.queuedSessions(userId)) {
    if (
      dependencies.draining() ||
      dependencies.runtimes.active(detail.id) ||
      !sessionRunnerIsAvailable(dependencies.runnerIsAvailable, userId, detail)
    ) {
      continue;
    }
    await dependencies.readCredential(userId, detail, (credential) => {
      if (dependencies.launch(detail, credential, userId)) {
        dependencies.notify(userId, detail.id);
      }
    });
  }
}
