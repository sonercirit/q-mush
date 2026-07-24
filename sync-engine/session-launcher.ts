import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import { runPersistedSession } from "./session-run.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

// cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
interface SessionLauncherDependencies {
  readonly actions: SessionAgentActions;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: RunnerCommandBroker;
  readonly finish: (
    detail: AgentSessionDetail,
    userId: string,
    error?: unknown,
  ) => void;
  readonly modelFactory: AgentModelFactory;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly realtime: RealtimeHub | undefined;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}
// cpd-ignore-end

export class SessionLauncher {
  // cpd-ignore-start -- The launcher delegates the same runtime signature as its integration owner.
  readonly #dependencies: SessionLauncherDependencies;

  constructor(dependencies: SessionLauncherDependencies) {
    this.#dependencies = dependencies;
  }

  launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    compact = false,
  ): boolean {
    return this.#dependencies.runtimes.launch(
      detail.id,
      detail.runnerId,
      ({ controller, restartRequest }) =>
        runPersistedSession({
          actions: this.#dependencies.actions,
          compact,
          controller,
          credential,
          detail,
          finish: this.#dependencies.finish,
          notify: this.#dependencies.notify,
          now: this.#dependencies.now,
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
        }),
    );
  }
  // cpd-ignore-end
}
