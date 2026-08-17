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
import type { DurableRestartPersistence } from "./session-restart-requester.ts";
import type { RestartHandoffIdentity } from "./session-restart-store.ts";
import { runPersistedSession } from "./session-run.ts";
import type {
  SessionPendingComponent,
  SessionRuntimes,
} from "./session-runtime.ts";
import type { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
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
  readonly shutdownInterrupted: Pick<
    ShutdownInterruptedSessionStore,
    "clear" | "mark"
  >;
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
    const clearShutdownMarker = () => {
      this.#dependencies.shutdownInterrupted.clear(
        detail.id,
        detail.generation,
        this.#dependencies.now(),
      );
    };
    return this.#dependencies.runtimes.launch(
      detail.id,
      detail.runnerId,
      detail.generation,
      operation === "agent" ? "step" : "handoff",
      async ({ controller, pendingComponent, restartRequest, settled }) => {
        const reportPending = (component: SessionPendingComponent): void => {
          pendingComponent(component);
          try {
            if (
              this.#dependencies.store.executionIsCurrent(
                userId,
                detail.id,
                detail.generation,
              )
            ) {
              this.#dependencies.notify(userId, detail.id);
            }
          } catch {
            // Diagnostic publication must not interrupt the model request.
          }
        };
        const restartPersistence: DurableRestartPersistence = {
          clear: clearShutdownMarker,
          operation: () =>
            this.#dependencies.store.manualCompactionPending(
              detail.id,
              detail.generation,
            )
              ? "compact_and_continue"
              : operation,
          persist: (request, durable) => {
            if (durable) {
              this.#dependencies.shutdownInterrupted.mark(
                detail.id,
                detail.generation,
                request.restartId,
                restartPersistence.operation(),
                this.#dependencies.now(),
              );
            }
          },
        };
        restartRequest(restartPersistence.persist);
        settled(restartPersistence.clear);
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
          restartPersistence,
          store: this.#dependencies.store,
          userId,
          pendingComponent: reportPending,
        });
      },
    );
  }
}
