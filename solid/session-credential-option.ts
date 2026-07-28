import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { ProviderCredential } from "./provider-client.tsx";
import {
  modelCredentialOptions,
  modelCredentialValue,
} from "./session-model-options.ts";

export interface SessionCredentialOption {
  readonly credential: ProviderCredential;
  readonly provider: ProviderId;
}

export function sessionCredentialValue(
  option: SessionCredentialOption,
): string {
  return modelCredentialValue({
    credentialId: option.credential.id,
    provider: option.provider,
  });
}

export function sessionCredentialSelectOptions(
  credentials: readonly SessionCredentialOption[],
) {
  return modelCredentialOptions(
    credentials.map(({ credential, provider }) => ({
      credentialId: credential.id,
      label: credential.label,
      provider,
    })),
  );
}
