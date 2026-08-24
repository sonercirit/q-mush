import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type {
  SessionCredentialReassignmentRequest,
  SessionCredentialReassignmentResult,
} from "../shared/session-credential-reassignment.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
} from "./http.ts";
import type {
  PreparedSessionCredentialProviderState,
  SessionCredentialReassignmentOptions,
  SessionCredentialReassignmentSnapshot,
  SessionCredentialReassignmentStore,
} from "./session-credential-reassignment-store.ts";

export interface SessionCredentialProviderPreparationContext {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly scope: SessionCredentialReassignmentOptions["scope"];
  readonly snapshot: SessionCredentialReassignmentSnapshot;
  readonly userId: string;
}

export type SessionCredentialProviderPreparationResult =
  | { readonly error: "provider_unavailable" | "validation_failed" }
  | { readonly preparedProviderState: PreparedSessionCredentialProviderState };

interface SessionCredentialReassignmentEndpointOptions {
  readonly auth: GoogleAuth;
  readonly now: () => number;
  readonly onChanged?: (userId: string) => void;
  readonly prepareProviderState?: (
    context: SessionCredentialProviderPreparationContext,
  ) => Promise<SessionCredentialProviderPreparationResult>;
  readonly provider: ProviderId;
  readonly scope?: (
    request: Request,
    userId: string,
  ) => SessionCredentialReassignmentOptions["scope"] | undefined;
  readonly store:
    | (Pick<SessionCredentialReassignmentStore, "reassign"> &
        Partial<Pick<SessionCredentialReassignmentStore, "snapshot">>)
    | undefined;
}

function readRequest(
  value: unknown,
): SessionCredentialReassignmentRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return {};
  }
  const workspaceId = value["workspaceId"];
  return keys.length === 1 &&
    typeof workspaceId === "string" &&
    workspaceId.length > 0
    ? { workspaceId }
    : undefined;
}

interface ReassignmentSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly scope?: Exclude<
    SessionCredentialReassignmentOptions["scope"],
    undefined
  >;
  readonly userId: string;
}

function reassignmentSelection(
  credentialId: string,
  provider: ProviderId,
  scope: SessionCredentialReassignmentOptions["scope"],
  userId: string,
): ReassignmentSelection {
  return {
    credentialId,
    provider,
    ...(scope === undefined ? {} : { scope }),
    userId,
  };
}

export interface SessionCredentialReassignmentEndpoints {
  readonly reassign: (
    request: Request,
    credentialId: string,
  ) => Promise<Response>;
}

export function createSessionCredentialReassignmentEndpoints(
  options: SessionCredentialReassignmentEndpointOptions,
): SessionCredentialReassignmentEndpoints {
  function storeUnavailable(): Response {
    return options.store === undefined
      ? createApiError("not_configured", 503)
      : createApiError("not_found", 404);
  }

  function reassign(request: Request, credentialId: string): Promise<Response> {
    if (request.method !== "POST") {
      return Promise.resolve(createMethodNotAllowedResponse("POST"));
    }

    return Promise.resolve(
      withAuthenticatedUser(options.auth, request, (user) =>
        reassignForUser(request, user, credentialId),
      ),
    );
  }

  async function reassignForUser(
    request: Request,
    user: AuthenticatedUser,
    credentialId: string,
  ): Promise<Response> {
    const body = await parseJsonRequest(request, readRequest);
    if (body === undefined) {
      return createApiError("invalid_request", 400);
    }
    const scope =
      options.scope === undefined
        ? body.workspaceId === undefined
          ? undefined
          : { workspaceId: body.workspaceId }
        : options.scope(request, user.id);
    if (
      options.scope !== undefined &&
      scope?.workspaceId !== (body.workspaceId ?? GLOBAL_WORKSPACE_ID)
    ) {
      return createApiError("invalid_scope", 409);
    }

    let preparedProviderState:
      PreparedSessionCredentialProviderState | undefined;
    if (options.prepareProviderState !== undefined) {
      const selection = reassignmentSelection(
        credentialId,
        options.provider,
        scope,
        user.id,
      );
      const snapshot = options.store?.snapshot?.(selection);
      if (snapshot === undefined) {
        return storeUnavailable();
      }
      let preparation: SessionCredentialProviderPreparationResult;
      try {
        preparation = await options.prepareProviderState({
          credentialId,
          provider: options.provider,
          scope,
          snapshot,
          userId: user.id,
        });
      } catch {
        return createApiError("openrouter_provider_validation_failed", 502);
      }
      if ("error" in preparation) {
        return createApiError(
          preparation.error === "provider_unavailable"
            ? "openrouter_provider_unavailable"
            : "openrouter_provider_validation_failed",
          preparation.error === "provider_unavailable" ? 409 : 502,
        );
      }
      preparedProviderState = preparation.preparedProviderState;
    }

    const result: SessionCredentialReassignmentResult | undefined =
      options.store?.reassign({
        ...reassignmentSelection(
          credentialId,
          options.provider,
          scope,
          user.id,
        ),
        now: options.now(),
        ...(preparedProviderState === undefined
          ? {}
          : { preparedProviderState }),
      });

    if (result === undefined) {
      return storeUnavailable();
    }

    if (result.migratedSessionCount > 0) {
      options.onChanged?.(user.id);
    }
    return createJsonResponse(result);
  }

  return { reassign };
}
