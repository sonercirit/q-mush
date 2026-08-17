import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";

export type StoredCredentialReadArguments =
  | [userId: string, credentialId: string]
  | [userId: string, credentialId: string, workspaceId: string];

export interface StoredProviderCredentialAccess {
  readCredential(
    ...arguments_: StoredCredentialReadArguments
  ): ProviderCredentialAccess | undefined;
  readonly persistSecret: (
    userId: string,
    credentialId: string,
    secret: string,
    now: number,
  ) => boolean;
}
