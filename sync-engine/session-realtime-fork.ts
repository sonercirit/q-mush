import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import {
  sessionForkSelection,
  type SessionForkInput,
} from "../shared/session-fork.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import { compactChangedSessionFork } from "./session-fork-compaction.ts";
import type { SessionLifecycleDependencies } from "./session-lifecycle-types.ts";
import {
  requireSessionMetadata,
  sessionMetadataFromDependencies,
} from "./session-provider-selection.ts";
import type { SessionStore } from "./session-store.ts";

interface SessionCredentialReader {
  readonly credential: (
    userId: string,
    selection: {
      readonly credentialId: string;
      readonly provider: "openai" | "openrouter";
      readonly workspaceId: string;
    },
  ) => Promise<ProviderCredentialAccess>;
}

export interface SessionForkDependencies
  extends SessionCredentialReader, SessionLifecycleDependencies {
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly store: Pick<SessionStore, "fork">;
}

async function selectedForkConfiguration(
  dependencies: SessionForkDependencies,
  userId: string,
  input: SessionForkInput,
  source: AgentSessionDetail,
) {
  const selection = sessionForkSelection(input);
  if (selection === undefined) return undefined;
  const credential = await dependencies.credential(userId, {
    ...selection,
    workspaceId: input.workspaceId,
  });
  const openRouterProviderTag =
    selection.provider === source.provider && selection.model === source.model
      ? source.openRouterProviderTag
      : null;
  const metadata = requireSessionMetadata(
    await sessionMetadataFromDependencies({
      credential,
      dependencies,
      input: {
        model: selection.model,
        openRouterProviderTag,
        provider: selection.provider,
      },
      ownerId: userId,
    }),
  );
  return {
    configuration: {
      credentialId: selection.credentialId,
      ...metadata,
      model: selection.model,
      openRouterProviderTag,
      provider: selection.provider,
      reasoningEffort:
        "reasoningEffort" in selection
          ? (selection.reasoningEffort ?? null)
          : source.reasoningEffort,
    },
    selection,
  };
}

export async function forkSessionForUser(options: {
  readonly compact: (sessionId: string) => Promise<AgentSessionDetail>;
  readonly dependencies: SessionForkDependencies;
  readonly input: SessionForkInput;
  readonly source: AgentSessionDetail;
  readonly user: AuthenticatedUser;
}): Promise<AgentSessionDetail> {
  const selected = await selectedForkConfiguration(
    options.dependencies,
    options.user.id,
    options.input,
    options.source,
  );
  const result = options.dependencies.store.fork(
    options.user.id,
    options.input.sourceSessionId,
    options.input.forkPointMessageId,
    options.input.workspaceId,
    options.dependencies.now(),
    selected?.configuration,
  );
  if (result.status !== "forked") {
    throw new RealtimeCommandError(result.status);
  }
  options.dependencies.notify(options.user.id, result.detail.id);
  return compactChangedSessionFork({
    compact: () => options.compact(result.detail.id),
    detail: result.detail,
    selection: selected?.selection,
    source: options.source,
  });
}
