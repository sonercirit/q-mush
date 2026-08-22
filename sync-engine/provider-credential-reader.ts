import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";

export interface ProviderCredentialRefreshRequest {
  readonly force?: boolean;
  readonly rejectedSecret?: string;
}

export type ProviderCredentialReadArguments = [
  userId: string,
  credentialId: string,
  workspaceId?: string,
  refresh?: ProviderCredentialRefreshRequest,
];

export type ProviderCredentialRead = (
  ...arguments_: ProviderCredentialReadArguments
) => Promise<ProviderCredentialAccess | undefined>;

export interface ProviderCredentialReader {
  credentials(request: Request): Promise<Response>;
  readonly readCredential: ProviderCredentialRead;
  reassignSessions(request: Request, credentialId: string): Promise<Response>;
  remove(request: Request, credentialId: string): Response;
  setDefault(request: Request, credentialId: string): Response;
  setScopes(request: Request, credentialId: string): Promise<Response>;
}
