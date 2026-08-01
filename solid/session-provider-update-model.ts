import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionProviderUpdateSelection } from "../shared/session-provider-update.ts";
import type { SessionModelDiscoverer } from "./session-model-options.ts";
import type { SessionProviderDiscoveryState } from "./session-provider-select.tsx";

interface SessionProviderUpdateCredential {
  readonly id: string;
  readonly isGlobal?: boolean;
  readonly label: string;
  readonly provider: ProviderId;
  readonly workspaceIds?: readonly string[];
}

export type SessionProviderUpdateDraft = SessionProviderUpdateSelection;

export interface SessionProviderUpdateView {
  readonly credentials: readonly SessionProviderUpdateCredential[];
  readonly onApply: (selection: SessionProviderUpdateDraft) => Promise<boolean>;
  readonly onDiscoverModels: SessionModelDiscoverer;
  readonly onDiscoverProviders: (
    credentialId: string,
    model: string,
  ) => Promise<SessionProviderDiscoveryState["catalog"] | undefined>;
}

export function sessionProviderUpdateDraft(
  detail: AgentSessionDetail,
): SessionProviderUpdateDraft {
  return {
    credentialId: detail.credentialId,
    model: detail.model,
    openRouterProviderTag: detail.openRouterProviderTag,
    provider: detail.provider,
  };
}

export function providerCredentialValue(
  selection: Pick<SessionProviderUpdateSelection, "credentialId" | "provider">,
): string {
  return `${selection.provider}:${selection.credentialId}`;
}
