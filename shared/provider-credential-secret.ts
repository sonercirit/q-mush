import {
  fingerprintCredential,
  type CredentialCipher,
} from "./credential-cipher.ts";
import type { ProviderApiFormat } from "./provider-id.ts";

function encryptionContext(userId: string, credentialId: string): string {
  return `${userId}:${credentialId}`;
}

export function encryptedCredentialValue(options: {
  readonly cipher: CredentialCipher;
  readonly credential: string;
  readonly credentialId: string;
  readonly userId: string;
}): string {
  return options.cipher.seal(
    options.credential,
    encryptionContext(options.userId, options.credentialId),
  );
}

export function decryptedCredentialValue(options: {
  readonly cipher: CredentialCipher;
  readonly credentialId: string;
  readonly encryptedCredential: string;
  readonly userId: string;
}): string {
  return options.cipher.open(
    options.encryptedCredential,
    encryptionContext(options.userId, options.credentialId),
  );
}

export interface ProviderEndpointMetadata {
  readonly apiFormat?: ProviderApiFormat;
  readonly baseUrl?: string;
}

export function presentProviderEndpointMetadata(options: {
  readonly apiFormat: ProviderApiFormat | null;
  readonly baseUrl: string | null;
}): ProviderEndpointMetadata {
  return {
    ...(options.apiFormat === null ? {} : { apiFormat: options.apiFormat }),
    ...(options.baseUrl === null ? {} : { baseUrl: options.baseUrl }),
  };
}

export function storedCredentialFingerprint(
  options: ProviderEndpointMetadata & {
    readonly credential: string;
  },
): string {
  const formatted =
    options.apiFormat === "anthropic"
      ? `${options.credential}\n${options.apiFormat}`
      : options.credential;
  return fingerprintCredential(
    options.baseUrl === undefined
      ? formatted
      : `${options.baseUrl}\n${formatted}`,
  );
}
