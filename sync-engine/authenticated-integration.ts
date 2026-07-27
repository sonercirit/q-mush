import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";

export class AuthenticatedIntegration {
  constructor(readonly auth: GoogleAuth) {}

  protected route(
    request: Request,
    serve: (userId: string, method: string) => Promise<Response> | Response,
  ) {
    const method = request.method;
    return withAuthenticatedUser(this.auth, request, ({ id }) =>
      serve(id, method),
    );
  }

  authenticate(
    request: Request,
    serve: (userId: string) => Promise<Response> | Response,
  ) {
    const authenticate = withAuthenticatedUser;
    return authenticate(this.auth, request, ({ id }) => serve(id));
  }
}
