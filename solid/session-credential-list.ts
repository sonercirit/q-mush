import type { ProviderViewState } from "./provider-client.tsx";
import type { SessionCredentialOption } from "./session-credential-option.ts";

export function credentialOptions(
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
): readonly SessionCredentialOption[] {
  return [
    ...(openAi.credentials ?? []).map((credential) => ({
      credential,
      provider: "openai" as const,
    })),
    ...(openRouter.credentials ?? []).map((credential) => ({
      credential,
      provider: "openrouter" as const,
    })),
  ];
}
