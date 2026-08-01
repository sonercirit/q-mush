import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import { createApiError } from "./http.ts";

interface SessionCredentialReader {
  readCredential(
    userId: string,
    credentialId: string,
    workspaceId?: string,
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<"openai" | "openrouter", SessionCredentialReader> &
    Partial<Record<Extract<ProviderId, "generic">, SessionCredentialReader>>
>;

export type SessionCredentialAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export interface SessionCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId?: string;
}

export interface SessionRuntimeSelection extends SessionCredentialSelection {
  readonly runnerId: string;
}

export function readSessionCredential(
  providers: SessionCredentialReaders,
  userId: string,
  selection: SessionCredentialSelection,
): Promise<ProviderCredentialAccess | undefined> {
  const reader = providers[selection.provider];
  return Promise.resolve(
    reader?.readCredential(
      userId,
      selection.credentialId,
      selection.workspaceId,
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
