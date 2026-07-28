import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { createApiError } from "./http.ts";

export type AuthenticatedAction<T extends Promise<Response> | Response> = (
  user: AuthenticatedUser,
) => T;

export interface Authenticator {
  authenticate<T extends Promise<Response> | Response>(
    request: Request,
    action: AuthenticatedAction<T>,
  ): Response | T;
}

export type Authenticate = Authenticator["authenticate"];

export function createConfiguredAuthenticator(
  auth: GoogleAuth,
  configured: () => boolean,
): Authenticator {
  return {
    authenticate: (request, action) =>
      withAuthenticatedConfiguredUser(auth, request, configured(), action),
  };
}

function configuredAuthenticatedAction<
  T extends Promise<Response> | Response,
>(options: {
  readonly action: AuthenticatedAction<T>;
  readonly configured: boolean;
}): AuthenticatedAction<Response | T> {
  return options.configured
    ? options.action
    : () => createApiError("not_configured", 503);
}

function withAuthenticatedConfiguredUser<
  T extends Promise<Response> | Response,
>(
  auth: GoogleAuth,
  request: Request,
  configured: boolean,
  action: AuthenticatedAction<T>,
): Response | T {
  const configuredAction = configuredAuthenticatedAction({
    action,
    configured,
  });
  return withAuthenticatedUser(auth, request, (user) => configuredAction(user));
}

export function withAuthenticatedUser<T extends Promise<Response> | Response>(
  auth: GoogleAuth,
  request: Request,
  action: AuthenticatedAction<T>,
): Response | T {
  const user = auth.authenticatedUser(request);
  return user === null
    ? createApiError("authentication_required", 401)
    : action(user);
}
