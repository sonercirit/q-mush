import type { ProviderId } from "./provider-id.ts";

const BALANCED_CREDENTIAL_PREFIX = "balanced:";

export function balancedCredentialId(provider: ProviderId): string {
  return `${BALANCED_CREDENTIAL_PREFIX}${provider}`;
}

export function isBalancedCredentialId(
  provider: ProviderId,
  credentialId: string,
): boolean {
  return credentialId === balancedCredentialId(provider);
}
