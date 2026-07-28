import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";

type SessionModelDiscoverer = (
  provider: "openai" | "openrouter",
  credential: ProviderCredentialAccess,
) => Promise<AgentModelCatalog>;

type AttachmentFallbackCredentialReader = (
  userId: string,
  selection: AttachmentFallbackSelection & { readonly workspaceId?: string },
) => Promise<ProviderCredentialAccess | undefined>;

export interface AttachmentFallbackRuntimeResources {
  readonly attachmentFallbacks?: () => readonly AttachmentFallbackSelection[];
  readonly discoverModels?: SessionModelDiscoverer;
  readonly readCredential?: AttachmentFallbackCredentialReader;
}
