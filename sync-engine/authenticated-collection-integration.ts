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
    const dispatch = (
      userId: string,
      method: string,
    ): Promise<Response> | Response => {
      let handler: AuthenticatedCollectionMethod | undefined;
      switch (method) {
        case "GET":
          handler = methods.GET;
          break;
        case "POST":
          handler = methods.POST;
          break;
        case "PUT":
          handler = methods.PUT;
          break;
        default:
          break;
      }
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
