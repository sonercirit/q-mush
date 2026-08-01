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
import type { SessionModelRuntimeResources } from "./session-model-runtime.ts";
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
  readonly attachmentFallbacks?: SessionModelRuntimeResources["attachmentFallbacks"];
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: Parameters<
    typeof runPersistedSession
  >[0]["resources"]["broker"];
  readonly finish: FinishSession;
  readonly discoverModels?: SessionModelRuntimeResources["discoverModels"];
  readonly beforeLaunch?: (detail: AgentSessionDetail) => Promise<void> | void;
  readonly modelFactory: AgentModelFactory;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly realtime: RealtimeHub | undefined;
  readonly readCredential?: SessionModelRuntimeResources["readCredential"];
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
      operation === "agent" ? "step" : "handoff",
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
            ...(this.#dependencies.attachmentFallbacks === undefined
              ? {}
              : {
                  attachmentFallbacks: this.#dependencies.attachmentFallbacks,
                }),
            braveSearch: this.#dependencies.braveSearch,
            broker: this.#dependencies.broker,
            ...(this.#dependencies.discoverModels === undefined
              ? {}
              : { discoverModels: this.#dependencies.discoverModels }),
            modelFactory: this.#dependencies.modelFactory,
            now: this.#dependencies.now,
            notify: this.#dependencies.notify,
            realtime: this.#dependencies.realtime,
            ...(this.#dependencies.readCredential === undefined
              ? {}
              : { readCredential: this.#dependencies.readCredential }),
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
