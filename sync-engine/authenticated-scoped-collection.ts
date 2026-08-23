import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createMethodNotAllowedResponse } from "./http.ts";
import { workspaceScopedCollectionResponse } from "./scoped-collection.ts";

export function scopedCollectionForUser<
  Created extends Promise<Response> | Response,
>(options: {
  readonly create: () => Created;
  readonly key: "credentials" | "runners";
  readonly read: (userId: string, workspaceId?: string) => readonly unknown[];
  readonly request: Request;
  readonly user: AuthenticatedUser;
  readonly validate: (userId: string, workspaceId: string) => boolean;
}): Created | Response {
  const handlers: Record<"GET" | "POST", () => Created | Response> = {
    GET: () =>
      workspaceScopedCollectionResponse(
        options.request,
        options.user,
        options.read,
        options.validate,
        options.key,
      ),
    POST: options.create,
  };
  const method = options.request.method;
  if (method === "GET" || method === "POST") return handlers[method]();
  return createMethodNotAllowedResponse("GET, POST");
}
