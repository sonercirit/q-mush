import type { AuthenticatedUser } from "./auth-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { createApiError } from "./http.ts";

export type AuthenticatedAction<T extends Promise<Response> | Response> = (
  user: AuthenticatedUser,
) => T;

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
