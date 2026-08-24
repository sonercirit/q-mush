import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
  SessionRuntimePendingComponent,
} from "../shared/session-model.ts";
import type { ActiveSessionTools } from "./active-session-tools.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { SessionModelRuntimeResources } from "./session-model-runtime.ts";
import type { DurableRestartPersistence } from "./session-restart-requester.ts";
import type { RestartHandoffIdentity } from "./session-restart-store.ts";
import { runPersistedSession } from "./session-run.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import type { SessionStore } from "./session-store.ts";

export type FinishSession = (
  detail: AgentSessionDetail,
  userId: string,
  error?: unknown,
  recovered?: RestartHandoffIdentity,
) => void;

export interface SessionLauncherDependencies {
  readonly activeTools: ActiveSessionTools;
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
  readonly modelFetch?: SessionModelRuntimeResources["modelFetch"];
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly realtime: RealtimeHub | undefined;
  readonly readCredential?: SessionModelRuntimeResources["readCredential"];
  readonly runtimes: SessionRuntimes;
  readonly shutdownInterrupted: Pick<
    ShutdownInterruptedSessionStore,
    "clear" | "mark"
  >;
  readonly shouldPersistRestartMarker?: (request: {
    readonly requestedBy: "runner" | "server";
  }) => boolean;
  readonly store: SessionStore;
}

export interface SessionLauncher {
  launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    operation?: RestartHandoffOperation,
  ): boolean;
}

export function createSessionLauncher(
  launcherDependencies: SessionLauncherDependencies,
): SessionLauncher {
  function launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    operation: RestartHandoffOperation = "agent",
  ): boolean {
    const clearShutdownMarker = () => {
      launcherDependencies.shutdownInterrupted.clear(
        detail.id,
        detail.generation,
        launcherDependencies.now(),
      );
    };
    return launcherDependencies.runtimes.launch(
      detail.id,
      detail.runnerId,
      detail.generation,
      operation === "agent" ? "step" : "handoff",
      async ({ controller, pendingComponent, restartRequest, settled }) => {
        const reportPending = (
          component: SessionRuntimePendingComponent,
        ): void => {
          // Repeated provider admission reports refresh watchdog liveness and
          // intentionally publish each bounded retry to realtime clients.
          if (!pendingComponent(component)) {
            return;
          }
          try {
            if (
              launcherDependencies.store.executionIsCurrent(
                userId,
                detail.id,
                detail.generation,
              )
            ) {
              launcherDependencies.notify(userId, detail.id);
            }
          } catch (error) {
            // Diagnostic publication must not interrupt the model request, but
            // unexpected persistence failures must remain observable.
            console.warn(
              `Session ${detail.id} pending diagnostic publication failed`,
              error,
            );
          }
        };
        const restartPersistence: DurableRestartPersistence = {
          clear: clearShutdownMarker,
          operation: () =>
            launcherDependencies.store.manualCompactionPending(
              detail.id,
              detail.generation,
            )
              ? "compact_and_continue"
              : operation,
          persist: (request, durable, forcePark = false) => {
            if (
              durable &&
              (forcePark ||
                (launcherDependencies.shouldPersistRestartMarker?.(request) ??
                  request.requestedBy === "server"))
            ) {
              launcherDependencies.shutdownInterrupted.mark(
                detail.id,
                detail.generation,
                request.restartId,
                restartPersistence.operation(),
                launcherDependencies.now(),
              );
            }
          },
        };
        restartRequest(restartPersistence.persist);
        settled(restartPersistence.clear);
        await launcherDependencies.beforeLaunch?.(detail);
        await runPersistedSession({
          controller,
          credential,
          detail,
          finish: launcherDependencies.finish,
          notify: launcherDependencies.notify,
          now: launcherDependencies.now,
          operation,
          pendingComponent: reportPending,
          resources: {
            activeTools: launcherDependencies.activeTools,
            actions: launcherDependencies.actions,
            ...(launcherDependencies.attachmentFallbacks === undefined
              ? {}
              : {
                  attachmentFallbacks: launcherDependencies.attachmentFallbacks,
                }),
            braveSearch: launcherDependencies.braveSearch,
            broker: launcherDependencies.broker,
            ...(launcherDependencies.discoverModels === undefined
              ? {}
              : { discoverModels: launcherDependencies.discoverModels }),
            modelFactory: launcherDependencies.modelFactory,
            ...(launcherDependencies.modelFetch === undefined
              ? {}
              : { modelFetch: launcherDependencies.modelFetch }),
            now: launcherDependencies.now,
            notify: launcherDependencies.notify,
            realtime: launcherDependencies.realtime,
            ...(launcherDependencies.readCredential === undefined
              ? {}
              : { readCredential: launcherDependencies.readCredential }),
            store: launcherDependencies.store,
          },
          restartRequest,
          restartPersistence,
          store: launcherDependencies.store,
          userId,
        });
      },
    );
  }
  return { launch };
}
