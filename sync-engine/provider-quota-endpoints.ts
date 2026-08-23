import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { ProviderQuotaStore } from "../shared/provider-quota-store.ts";
import {
  DEFAULT_AUTO_RESET_THRESHOLD_PERCENT,
  type ProviderQuotaResetOutcome,
  type ProviderQuotaResetResult,
  type ProviderQuotaSnapshot,
} from "../shared/provider-quota.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  createConfiguredAuthenticator,
  type AuthenticatedAction,
  type Authenticator,
} from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createNoContentResponse,
  parseRecordJsonForMethod,
  requireRequestMethod,
} from "./http.ts";
import type {
  ProviderQuotaReader,
  ProviderQuotaResetter,
} from "./provider-quota.ts";

const REQUEST_ID_PATTERN = /^[A-Za-z\d_-]{1,200}$/u;

function quotaUnavailable(threshold: number): ProviderQuotaSnapshot {
  return {
    autoResetThresholdPercent: threshold,
    bankedResetCount: null,
    estimatedExhaustionAt: null,
    remainingPercent: null,
    resetSupported: false,
    resetsAt: null,
    source: "Provider quota unavailable",
  };
}

function isResetOutcome(value: string): value is ProviderQuotaResetOutcome {
  return [
    "already_redeemed",
    "no_credit",
    "nothing_to_reset",
    "reset",
  ].includes(value);
}

function isDefinitiveNonSpendOutcome(
  outcome: ProviderQuotaResetOutcome,
): boolean {
  return outcome === "no_credit" || outcome === "nothing_to_reset";
}

export interface ProviderQuotaDependencies {
  readonly now: () => number;
  readonly quotaStore: ProviderQuotaStore | undefined;
  readonly readCredential: (
    userId: string,
    credentialId: string,
  ) => Promise<ProviderCredentialAccess | undefined>;
  readonly readQuota: ProviderQuotaReader;
  readonly resetQuota: ProviderQuotaResetter;
}

export interface ProviderQuotaEndpoints {
  readonly consume: (request: Request, credentialId: string) => Promise<Response>;
  readonly read: (request: Request, credentialId: string) => Promise<Response> | Response;
  readonly setThreshold: (request: Request, credentialId: string) => Promise<Response>;
}

export function createProviderQuotaEndpoints(
  auth: GoogleAuth,
  dependencies: ProviderQuotaDependencies,
): ProviderQuotaEndpoints {
  const authenticate: Authenticator = createConfiguredAuthenticator(
    auth,
    () => dependencies.quotaStore !== undefined,
  );

  function authenticated<T extends Promise<Response> | Response>(options: {
    readonly action: AuthenticatedAction<T>;
    readonly request: Request;
  }): Response | T {
    return authenticate.authenticate(options.request, options.action);
  }

  function readCredential(
    userId: string,
    credentialId: string,
  ): Promise<ProviderCredentialAccess | undefined> {
    return dependencies.readCredential(userId, credentialId);
  }

  async function requiredCredential(
    userId: string,
    credentialId: string,
  ): Promise<ProviderCredentialAccess> {
    const credential = await readCredential(userId, credentialId);
    if (credential === undefined)
      throw new Error("Provider credential is unavailable");
    return credential;
  }

  function read(request: Request, credentialId: string): Promise<Response> | Response {
    const methodError = requireRequestMethod(request, "GET");
    if (methodError !== undefined) return methodError;
    return authenticated({
      request,
      action: async (user) => {
        let credential: ProviderCredentialAccess;
        try {
          credential = await requiredCredential(user.id, credentialId);
        } catch {
          return createApiError("not_found", 404);
        }
        const setting = dependencies.quotaStore?.read(
          user.id,
          credentialId,
        );
        const threshold =
          setting?.autoResetThresholdPercent ??
          DEFAULT_AUTO_RESET_THRESHOLD_PERCENT;
        try {
          let quota = await dependencies.readQuota(credential, threshold);
          if (
            quota.resetSupported &&
            quota.bankedResetCount !== null &&
            quota.bankedResetCount > 0 &&
            quota.remainingPercent !== null &&
            quota.remainingPercent <= threshold
          ) {
            const window = quota.resetsAt ?? "unknown-window";
            const requestId = `auto-${credentialId}-${String(window)}`;
            await consumeReset(user, credentialId, requestId);
            quota = await dependencies.readQuota(credential, threshold);
          }
          return createJsonResponse(quota);
        } catch {
          return createJsonResponse(quotaUnavailable(threshold));
        }
      },
    });
  }

  async function setThreshold(
    request: Request,
    credentialId: string,
  ): Promise<Response> {
    const parsed = await parseRecordJsonForMethod(request, "PUT", (value) => {
      const threshold = value["autoResetThresholdPercent"];
      return typeof threshold === "number" &&
        Number.isFinite(threshold) &&
        threshold >= 0 &&
        threshold <= 100
        ? threshold
        : undefined;
    });
    if (parsed instanceof Response) return parsed;
    if (parsed === undefined) return createApiError("invalid_request", 400);
    return authenticated({
      request,
      action: async (user) => {
        if ((await readCredential(user.id, credentialId)) === undefined) {
          return createApiError("not_found", 404);
        }
        dependencies.quotaStore?.setThreshold(
          user.id,
          credentialId,
          parsed,
          dependencies.now(),
        );
        return createNoContentResponse();
      },
    });
  }

  async function consume(request: Request, credentialId: string): Promise<Response> {
    const requestId = await parseRecordJsonForMethod(
      request,
      "POST",
      (value) => {
        const candidate = value["clientRequestId"];
        return typeof candidate === "string" &&
          REQUEST_ID_PATTERN.test(candidate)
          ? candidate
          : undefined;
      },
    );
    if (requestId instanceof Response) return requestId;
    if (requestId === undefined) return createApiError("invalid_request", 400);
    return authenticated({
      action: (user) => consumeResponse(user, credentialId, requestId),
      request,
    });
  }

  async function consumeResponse(
    user: AuthenticatedUser,
    credentialId: string,
    requestId: string,
  ): Promise<Response> {
    try {
      const result = await consumeReset(user, credentialId, requestId);
      return result === undefined
        ? createApiError("reset_in_progress", 409)
        : createJsonResponse(result);
    } catch {
      return createApiError("provider_unavailable", 502);
    }
  }

  function resetResult(
    credential: ProviderCredentialAccess,
    threshold: number,
    outcome: ProviderQuotaResetOutcome,
    replayed: boolean,
  ): Promise<ProviderQuotaResetResult> {
    return dependencies
      .readQuota(credential, threshold)
      .then((quota) => ({ outcome, quota, replayed }));
  }

  async function consumeReset(
    user: AuthenticatedUser,
    credentialId: string,
    requestId: string,
  ): Promise<ProviderQuotaResetResult | undefined> {
    const credential = await requiredCredential(user.id, credentialId);
    const quotaStore = dependencies.quotaStore;
    if (quotaStore === undefined) {
      throw new Error("Quota settings are unavailable");
    }
    const setting = quotaStore.read(user.id, credentialId);
    const reservation = quotaStore.reserveReset(
      user.id,
      credentialId,
      requestId,
      dependencies.now(),
    );
    if (reservation.replayedResult !== undefined) {
      if (!isResetOutcome(reservation.replayedResult)) {
        throw new Error("The stored reset result is invalid");
      }
      return resetResult(
        credential,
        setting.autoResetThresholdPercent,
        reservation.replayedResult,
        true,
      );
    }
    if (!reservation.reserved) {
      return undefined;
    }
    const outcome = await dependencies.resetQuota(
      credential,
      reservation.providerRequestId,
    );
    const completedAt = dependencies.now();
    if (isDefinitiveNonSpendOutcome(outcome)) {
      quotaStore.releaseReset(
        user.id,
        credentialId,
        reservation.providerRequestId,
        completedAt,
        reservation.leaseAcquiredAt,
      );
    } else {
      quotaStore.completeReset(
        user.id,
        credentialId,
        reservation.providerRequestId,
        outcome,
        completedAt,
        requestId,
        reservation.leaseAcquiredAt,
      );
    }
    return await resetResult(
      credential,
      setting.autoResetThresholdPercent,
      outcome,
      false,
    );
  }

  return { consume, read, setThreshold };
}
