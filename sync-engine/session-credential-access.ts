import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import { createApiError } from "./http.ts";
import type { ProviderCredentialRefreshRequest } from "./provider-credential-reader.ts";
import type { SessionCredentialReaders } from "./session-credential-readers.ts";

export type SessionCredentialAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export interface SessionCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId?: string;
}

export type SessionCredentialRead = (
  userId: string,
  selection: SessionCredentialSelection,
  refresh?: ProviderCredentialRefreshRequest,
) => Promise<ProviderCredentialAccess | undefined>;

export function readSessionCredential(
  providers: SessionCredentialReaders,
  userId: string,
  selection: SessionCredentialSelection,
  refresh?: ProviderCredentialRefreshRequest,
): Promise<ProviderCredentialAccess | undefined> {
  const reader = providers[selection.provider];
  return Promise.resolve(
    reader?.readCredential(
      userId,
      selection.credentialId,
      selection.workspaceId,
      refresh,
    ),
  );
}

export async function withSessionCredential(
  providers: SessionCredentialReaders,
  userId: string,
  selection: SessionCredentialSelection,
  action: SessionCredentialAction,
): Promise<Response> {
  let credential: ProviderCredentialAccess | undefined;
  try {
    credential = await readSessionCredential(providers, userId, selection);
  } catch {
    return createApiError("credential_refresh_failed", 502);
  }
  return credential === undefined
    ? createApiError("credential_unavailable", 409)
    : action(credential);
}
