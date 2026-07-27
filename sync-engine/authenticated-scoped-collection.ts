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
  switch (options.request.method) {
    case "GET":
      return workspaceScopedCollectionResponse(
        options.request,
        options.user,
        options.read,
        options.validate,
        options.key,
      );
    case "POST":
      return options.create();
    default:
      return createMethodNotAllowedResponse("GET, POST");
  }
}
