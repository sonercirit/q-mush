import { balancedCredentialId } from "../shared/provider-credential-pool.ts";
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

export function selectedSessionCredentialOption(
  credentials: readonly SessionCredentialOption[],
  value: string,
): SessionCredentialOption | undefined {
  const direct = credentials.find(
    (option) => sessionCredentialValue(option) === value,
  );
  if (direct !== undefined) return direct;
  return credentials.find(
    ({ provider }) =>
      modelCredentialValue({
        credentialId: balancedCredentialId(provider),
        provider,
      }) === value,
  );
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
