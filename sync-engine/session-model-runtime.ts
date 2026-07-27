import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionModelRuntimeResources {
  readonly actions: SessionAgentActions;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: SessionAgentRuntimeDependencies["broker"];
  readonly modelFactory: AgentModelFactory;
  readonly now: typeof Date.now;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly realtime: RealtimeHub | undefined;
  readonly store: SessionStore;
}

export function sessionModelRuntime(
  resources: SessionModelRuntimeResources,
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  userId: string,
  controller: AbortController,
  restartHandoffRequested: () => boolean = () => false,
): SessionAgentRuntimeDependencies {
  return {
    braveSearch: resources.braveSearch,
    broker: resources.broker,
    credential,
    detail,
    currentTools: () => resources.store.get(userId, detail.id)?.tools,
    isCurrent: () =>
      resources.store.executionIsCurrent(userId, detail.id, detail.generation),
    modelFactory: resources.modelFactory,
    now: resources.now,
    restartHandoffRequested,
    notify: () => {
      if (
        resources.store.executionIsCurrent(userId, detail.id, detail.generation)
      ) {
        resources.notify(userId, detail.id);
      }
    },
    realtime: resources.realtime,
    sessionTools: resources.actions.actions(
      detail.id,
      userId,
      detail.generation,
      controller.signal,
    ),
    signal: controller.signal,
    store: resources.store,
    userId,
  };
}
