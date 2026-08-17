import type { AgentModelStep } from "../shared/agent-loop.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { AgentCredentialRefresher } from "./agent-model-options.ts";
import {
  ProviderCredentialRejectionError,
  ProviderStreamError,
} from "./provider-error.ts";

function isOpenAiOAuthUnauthorized(
  error: unknown,
  provider: ProviderId,
  source: ProviderCredentialAccess["source"],
): boolean {
  return (
    provider === "openai" &&
    source === "oauth" &&
    ((error instanceof ProviderCredentialRejectionError &&
      error.status === 401) ||
      (error instanceof ProviderStreamError && error.status === 401))
  );
}

export async function recoverOpenAiOAuthUnauthorized(options: {
  readonly complete: () => Promise<AgentModelStep>;
  readonly currentCredential: Parameters<AgentCredentialRefresher>[0];
  readonly error: unknown;
  readonly provider: ProviderId;
  readonly refreshCredential: AgentCredentialRefresher | undefined;
  readonly replaceCredential: (
    credential: Awaited<ReturnType<AgentCredentialRefresher>>,
  ) => void;
  readonly resetOutput: () => void;
  readonly resetTransport: () => void;
}): Promise<AgentModelStep> {
  if (
    !isOpenAiOAuthUnauthorized(
      options.error,
      options.provider,
      options.currentCredential.source,
    )
  ) {
    throw options.error;
  }
  if (options.refreshCredential === undefined) {
    throw options.error;
  }

  const refreshed = await options.refreshCredential(options.currentCredential);
  options.replaceCredential(refreshed);
  options.resetOutput();
  options.resetTransport();
  return options.complete();
}
