import {
  fingerprintCredential,
  type CredentialCipher,
} from "./credential-cipher.ts";

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

export function storedCredentialFingerprint(options: {
  readonly apiFormat?: string;
  readonly baseUrl?: string;
  readonly credential: string;
}): string {
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
