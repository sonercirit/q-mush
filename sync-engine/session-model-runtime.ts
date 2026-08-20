import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { ActiveSessionTools } from "./active-session-tools.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import { hasPendingSteeringInput } from "./session-pending-inputs.ts";
import type { SessionStore } from "./session-store.ts";

interface SessionAgentActionsLike {
  actions(
    parentSessionId: string,
    userId: string,
    parentGeneration: number,
    toolSettings?: ToolSettings,
  ): SessionAgentRuntimeDependencies["sessionTools"];
}

export interface SessionModelRuntimeResources extends Omit<
  AttachmentFallbackRuntimeResources,
  "attachmentFallbacks"
> {
  readonly activeTools: ActiveSessionTools;
  readonly actions: SessionAgentActionsLike;
  readonly attachmentFallbacks?: (
    userId: string,
  ) => readonly AttachmentFallbackSelection[];
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
  const toolSettings = resources.store.toolSettings(
    detail.id,
    detail.generation,
  );
  return {
    activeTools: resources.activeTools,
    ...(resources.attachmentFallbacks === undefined
      ? {}
      : {
          attachmentFallbacks: () =>
            resources.attachmentFallbacks?.(userId) ?? [],
        }),
    braveSearch: resources.braveSearch,
    broker: resources.broker,
    credential,
    continuous: detail.generation > 0,
    detail,
    ...(resources.discoverModels === undefined
      ? {}
      : { discoverModels: resources.discoverModels }),
    hasPendingSteeringInput: () =>
      hasPendingSteeringInput(
        resources.store.get(userId, detail.id)?.pendingInputs ?? [],
      ),
    currentTools: () => resources.store.get(userId, detail.id)?.tools,
    isCurrent: () =>
      resources.store.executionIsCurrent(userId, detail.id, detail.generation),
    manualCompactionRequested: () =>
      resources.store.manualCompactionPending(detail.id, detail.generation),
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
    ...(resources.readCredential === undefined
      ? {}
      : { readCredential: resources.readCredential }),
    sessionTools: resources.actions.actions(
      detail.id,
      userId,
      detail.generation,
      toolSettings,
    ),
    signal: controller.signal,
    store: resources.store,
    toolSettings,
    userId,
  };
}
