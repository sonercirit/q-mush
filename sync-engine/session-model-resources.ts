import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { AgentModelFetch } from "./agent-model.ts";

type AttachmentFallbackCredentialReader = (
  userId: string,
  selection: AttachmentFallbackSelection & { readonly workspaceId?: string },
) => Promise<ProviderCredentialAccess | undefined>;

export interface AttachmentFallbackRuntimeResources {
  readonly attachmentFallbacks?: () => readonly AttachmentFallbackSelection[];
  readonly discoverModels?: AgentModelDiscoverer;
  readonly modelFetch?: AgentModelFetch;
  readonly readCredential?: AttachmentFallbackCredentialReader;
}
