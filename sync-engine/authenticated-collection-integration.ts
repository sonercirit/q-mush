import type { GoogleAuth } from "./auth.ts";
import { AuthenticatedIntegration } from "./authenticated-integration.ts";
import { createMethodNotAllowedResponse } from "./http.ts";

type AuthenticatedCollectionMethod = (
  userId: string,
) => Promise<Response> | Response;

export abstract class AuthenticatedCollectionIntegration extends AuthenticatedIntegration {
  protected collectionRoute(
    request: Request,
    methods: Readonly<
      Partial<Record<"GET" | "POST" | "PUT", AuthenticatedCollectionMethod>>
    >,
  ): Promise<Response> | Response {
    const handlers: Readonly<
      Record<"GET" | "POST" | "PUT", AuthenticatedCollectionMethod | undefined>
    > = {
      GET: methods.GET,
      POST: methods.POST,
      PUT: methods.PUT,
    };
    const dispatch = (
      userId: string,
      method: string,
    ): Promise<Response> | Response => {
      const handler =
        method === "GET" || method === "POST" || method === "PUT"
          ? handlers[method]
          : undefined;
      return handler === undefined
        ? createMethodNotAllowedResponse(Object.keys(methods).join(", "))
        : handler(userId);
    };
    return this.route(request, dispatch);
  }

  protected constructor(auth: GoogleAuth) {
    super(auth);
  }
}
