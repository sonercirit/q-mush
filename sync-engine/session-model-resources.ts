import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";

type AttachmentFallbackCredentialReader = (
  userId: string,
  selection: AttachmentFallbackSelection & { readonly workspaceId?: string },
) => Promise<ProviderCredentialAccess | undefined>;

export interface AttachmentFallbackRuntimeResources {
  readonly attachmentFallbacks?: () => readonly AttachmentFallbackSelection[];
  readonly discoverModels?: AgentModelDiscoverer;
  readonly readCredential?: AttachmentFallbackCredentialReader;
}
