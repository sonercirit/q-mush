import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";

export interface AuthenticatedIntegration {
  readonly auth: GoogleAuth;
  authenticate(
    request: Request,
    serve: (userId: string) => Promise<Response> | Response,
  ): Promise<Response> | Response;
  route(
    request: Request,
    serve: (userId: string, method: string) => Promise<Response> | Response,
  ): Promise<Response> | Response;
}

export function createAuthenticatedIntegration(
  auth: GoogleAuth,
): AuthenticatedIntegration {
  const authenticate: AuthenticatedIntegration["authenticate"] = (
    request,
    serve,
  ) => withAuthenticatedUser(auth, request, ({ id }) => serve(id));
  const route: AuthenticatedIntegration["route"] = (request, serve) => {
    const method = request.method;
    return withAuthenticatedUser(auth, request, ({ id }) => serve(id, method));
  };
  return { auth, authenticate, route };
}
