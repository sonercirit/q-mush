import { Show, type JSX } from "solid-js";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { sessionContextLabel } from "./session-context-client.tsx";
import { SessionDetailBody } from "./session-detail-body.tsx";
import type {
  LoadedSessionDetailViewProps,
  SessionDetailViewProps,
} from "./session-detail-view-props.ts";
import {
  discoverProviderUpdateModels,
  discoverProviderUpdateProviders,
  updateSessionProvider,
} from "./session-provider-update-controller.ts";
import type { SessionProviderUpdateDraft } from "./session-provider-update-model.ts";

import {
  executionEnvironmentLabel,
  SessionMetrics,
  sessionModelLabel,
  statusBadge,
} from "./session-summary-presentation.tsx";

export { SessionList } from "./session-list.tsx";

function LoadedSessionDetail(props: LoadedSessionDetailViewProps): JSX.Element {
  const providerUpdate = () => ({
    credentials: props.credentials.map(({ credential, provider }) => ({
      ...credential,
      provider,
    })),
    onApply: async (selection: SessionProviderUpdateDraft) => {
      const updated = await updateSessionProvider({
        confirmed: true,
        detail: props.detail,
        selection,
        transport: props.controller.transport,
      });
      props.controller.applyDetail(updated);
      return true;
    },
    onDiscoverModels: (
      provider: AgentSessionSummary["provider"],
      credentialId: string,
    ) =>
      discoverProviderUpdateModels(
        props.controller.transport,
        provider,
        credentialId,
      ),
    onDiscoverProviders: (credentialId: string, model: string) =>
      discoverProviderUpdateProviders(
        credentialId,
        model,
        props.detail.workspaceId,
      ),
  });
  return (
    <SessionDetailBody
      contextLabel={sessionContextLabel(props.detail)}
      environmentLabel={executionEnvironmentLabel(
        props.detail.executionEnvironment,
      )}
      modelLabel={sessionModelLabel(props.detail)}
      presentation={statusBadge(props.detail)}
      providerUpdate={providerUpdate()}
      sessionMetrics={<SessionMetrics session={props.detail} />}
      view={props}
    />
  );
}

export function SessionDetail(props: SessionDetailViewProps): JSX.Element {
  return (
    <Show
      fallback={
        <div class="grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/15 text-sm text-slate-500">
          Select a session to view its transcript.
        </div>
      }
      when={props.state.selectedId}
    >
      <Show
        fallback={<p class="text-sm text-slate-400">Loading transcript…</p>}
        when={props.state.loadingDetail ? undefined : props.state.detail}
      >
        {(detail) => (
          <LoadedSessionDetail
            {...props}
            credentialAvailable={props.credentialAvailable}
            detail={detail()}
          />
        )}
      </Show>
    </Show>
  );
}
