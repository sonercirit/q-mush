import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { AgentModelFetch } from "./agent-model.ts";
import type { SessionCredentialRead } from "./session-credential-access.ts";

export interface AttachmentFallbackRuntimeResources {
  readonly attachmentFallbacks?: () => readonly AttachmentFallbackSelection[];
  readonly discoverModels?: AgentModelDiscoverer;
  readonly modelFetch?: AgentModelFetch;
  readonly readCredential?: SessionCredentialRead;
}
