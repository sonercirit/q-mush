import type { AgentModelStep } from "../shared/agent-loop.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type {
  AgentCredentialRefresher,
  AgentProviderCredential,
} from "./agent-model-options.ts";
import {
  isProviderCredentialRejection,
  isProviderStreamError,
} from "./provider-error.ts";

function isOpenAiOAuthUnauthorized(
  error: unknown,
  provider: ProviderId,
  source: ProviderCredentialAccess["source"],
): boolean {
  return (
    provider === "openai" &&
    source === "oauth" &&
    ((isProviderCredentialRejection(error) && error.status === 401) ||
      (isProviderStreamError(error) &&
        (error.status === 401 || error.authenticationFailure)))
  );
}

export async function recoverOpenAiOAuthUnauthorized(options: {
  readonly complete: () => Promise<AgentModelStep>;
  readonly currentCredential: AgentProviderCredential;
  readonly error: unknown;
  readonly provider: ProviderId;
  readonly refreshCredential: AgentCredentialRefresher | undefined;
  readonly replaceCredential: (credential: AgentProviderCredential) => void;
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
