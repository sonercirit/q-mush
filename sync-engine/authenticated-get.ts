import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createMethodNotAllowedResponse } from "./http.ts";

export type AuthenticatedUserAction = (
  user: AuthenticatedUser,
) => Promise<Response>;

interface AuthenticatedGetOptions {
  readonly action: AuthenticatedUserAction;
  readonly forUser: (
    request: Request,
    action: AuthenticatedUserAction,
  ) => Promise<Response> | Response;
}

export function authenticatedGet(
  request: Request,
  options: AuthenticatedGetOptions,
): Promise<Response> {
  return Promise.resolve(
    request.method === "GET"
      ? options.forUser(request, options.action)
      : createMethodNotAllowedResponse("GET"),
  );
}
