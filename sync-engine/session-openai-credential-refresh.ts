import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentCredentialRefresher } from "./agent-model-options.ts";
import {
  createProviderCredentialReauthenticationRequiredError,
  isProviderCredentialReauthenticationRequiredError,
  isProviderCredentialRejection,
} from "./provider-error.ts";
import type { SessionCredentialRead } from "./session-credential-access.ts";

export interface OpenAiCredentialRefreshOptions {
  readonly credential: ProviderCredentialAccess;
  readonly readCredential: SessionCredentialRead | undefined;
  readonly selection: Parameters<SessionCredentialRead>[1];
  readonly userId: string;
}

export function createOpenAiSessionCredentialRefresher(
  options: OpenAiCredentialRefreshOptions,
): AgentCredentialRefresher | undefined {
  if (
    options.selection.provider !== "openai" ||
    options.credential.source !== "oauth" ||
    options.readCredential === undefined
  ) {
    return undefined;
  }

  return async (rejectedCredential) => {
    try {
      const refreshed = await options.readCredential?.(
        options.userId,
        options.selection,
        { force: true, rejectedSecret: rejectedCredential.secret },
      );
      if (refreshed === undefined) {
        throw new Error("The OpenAI credential is no longer available");
      }
      return refreshed;
    } catch (error) {
      if (isProviderCredentialReauthenticationRequiredError(error)) {
        throw error;
      }
      if (isProviderCredentialRejection(error)) {
        throw createProviderCredentialReauthenticationRequiredError("OpenAI");
      }
      throw error;
    }
  };
}
