import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import { createMethodNotAllowedResponse } from "./http.ts";

type AuthenticatedCollectionMethod = (
  userId: string,
) => Promise<Response> | Response;

type CollectionRoute = (
  request: Request,
  methods: Readonly<
    Partial<Record<"GET" | "POST" | "PUT", AuthenticatedCollectionMethod>>
  >,
) => Promise<Response> | Response;

export interface AuthenticatedCollectionIntegration {
  readonly collectionRoute: CollectionRoute;
  readonly route: (
    request: Request,
    serve: (userId: string, method: string) => Promise<Response> | Response,
  ) => Promise<Response> | Response;
}

export function createAuthenticatedCollectionIntegration(
  auth: GoogleAuth,
): AuthenticatedCollectionIntegration {
  const route = (
    request: Request,
    serve: (userId: string, method: string) => Promise<Response> | Response,
  ): Promise<Response> | Response => {
    const method = request.method;
    return withAuthenticatedUser(auth, request, ({ id }) => serve(id, method));
  };
  const collectionRoute: CollectionRoute = (request, methods) => {
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
    return route(request, dispatch);
  };
  return { collectionRoute, route };
}

interface AuthenticatedCollectionIntegrationConstructor {
  new (auth: GoogleAuth): AuthenticatedCollectionIntegration;
}

// Constructable compatibility lets existing integrations migrate independently.
export const AuthenticatedCollectionIntegration: AuthenticatedCollectionIntegrationConstructor =
  function (this: AuthenticatedCollectionIntegration, auth: GoogleAuth): void {
    Object.assign(this, createAuthenticatedCollectionIntegration(auth));
  } as unknown as AuthenticatedCollectionIntegrationConstructor;
