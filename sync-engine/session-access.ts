import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError } from "./http.ts";

interface CredentialReader {
  readCredential(
    userId: string,
    credentialId: string,
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<ProviderId, CredentialReader>
>;

export interface SessionCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

export interface SessionRuntimeSelection extends SessionCredentialSelection {
  readonly runnerId: string;
}

export type SessionCredentialAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export async function withSessionCredential(options: {
  readonly action: SessionCredentialAction;
  readonly providers: SessionCredentialReaders;
  readonly selection: SessionCredentialSelection;
  readonly userId: string;
}): Promise<Response> {
  let credential: ProviderCredentialAccess | undefined;

  try {
    credential = await options.providers[
      options.selection.provider
    ].readCredential(options.userId, options.selection.credentialId);
  } catch {
    return createApiError("credential_refresh_failed", 502);
  }

  return credential === undefined
    ? createApiError("credential_unavailable", 409)
    : options.action(credential);
}

interface SessionReader {
  get(userId: string, sessionId: string): AgentSessionDetail | undefined;
}

export function storedSessionResponse(
  store: SessionReader,
  userId: string,
  sessionId: string,
): Response {
  const detail = store.get(userId, sessionId);
  return detail === undefined
    ? createApiError("not_found", 404)
    : Response.json(detail);
}

export function withStoredSession(
  store: SessionReader,
  user: AuthenticatedUser,
  sessionId: string,
  action: (session: AgentSessionDetail) => Promise<Response> | Response,
): Promise<Response> | Response {
  const session = store.get(user.id, sessionId);
  return session === undefined
    ? createApiError("not_found", 404)
    : action(session);
}
