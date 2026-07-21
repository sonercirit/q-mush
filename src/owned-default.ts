import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createMethodNotAllowedResponse,
  createNoContentResponse,
} from "./http.ts";

export function setOwnedDefault(
  request: Request,
  auth: GoogleAuth,
  update: (userId: string) => boolean,
): Response {
  if (request.method.toLowerCase() !== "post") {
    return createMethodNotAllowedResponse("POST");
  }

  return withAuthenticatedUser(auth, request, (user) =>
    update(user.id)
      ? createNoContentResponse()
      : createApiError("not_found", 404),
  );
}
