import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import { createApiError } from "./http.ts";

interface SessionCredentialReader {
  readCredential(
    userId: string,
    credentialId: string,
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<ProviderId, SessionCredentialReader>
>;

export type SessionCredentialAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export interface SessionCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

export function readSessionCredential(
  providers: SessionCredentialReaders,
  userId: string,
  selection: SessionCredentialSelection,
): Promise<ProviderCredentialAccess | undefined> {
  return Promise.resolve(
    providers[selection.provider].readCredential(
      userId,
      selection.credentialId,
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
