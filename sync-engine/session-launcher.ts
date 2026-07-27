import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { RestartHandoffIdentity } from "./session-restart-store.ts";
import { runPersistedSession } from "./session-run.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export type FinishSession = (
  detail: AgentSessionDetail,
  userId: string,
  error?: unknown,
  recovered?: RestartHandoffIdentity,
) => void;

interface SessionLauncherDependencies {
  readonly actions: SessionAgentActions;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: Parameters<
    typeof runPersistedSession
  >[0]["resources"]["broker"];
  readonly finish: FinishSession;
  readonly beforeLaunch?: (detail: AgentSessionDetail) => Promise<void> | void;
  readonly modelFactory: AgentModelFactory;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly realtime: RealtimeHub | undefined;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}

export class SessionLauncher {
  readonly #dependencies: SessionLauncherDependencies;

  constructor(dependencies: SessionLauncherDependencies) {
    this.#dependencies = dependencies;
  }

  launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    operation: RestartHandoffOperation = "agent",
  ): boolean {
    return this.#dependencies.runtimes.launch(
      detail.id,
      detail.runnerId,
      detail.generation,
      async ({ controller, restartRequest }) => {
        await this.#dependencies.beforeLaunch?.(detail);
        await runPersistedSession({
          controller,
          credential,
          detail,
          finish: this.#dependencies.finish,
          notify: this.#dependencies.notify,
          now: this.#dependencies.now,
          operation,
          resources: {
            actions: this.#dependencies.actions,
            braveSearch: this.#dependencies.braveSearch,
            broker: this.#dependencies.broker,
            modelFactory: this.#dependencies.modelFactory,
            now: this.#dependencies.now,
            notify: this.#dependencies.notify,
            realtime: this.#dependencies.realtime,
            store: this.#dependencies.store,
          },
          restartRequest,
          store: this.#dependencies.store,
          userId,
        });
      },
    );
  }
}
