import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ProviderViewState } from "./provider-client.tsx";

export function selectedSessionCredentialAvailable(
  detail: AgentSessionDetail | undefined,
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
  generic?: ProviderViewState,
): boolean | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const provider =
    detail.provider === "openai"
      ? openAi
      : detail.provider === "openrouter"
        ? openRouter
        : generic;
  if (provider === undefined) {
    return undefined;
  }
  if (provider.credentials !== undefined) {
    return provider.credentials.some(({ id }) => id === detail.credentialId);
  }
  return provider.error === undefined ? undefined : false;
}
