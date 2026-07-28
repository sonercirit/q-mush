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

export class ProviderQuotaEndpoints {
  readonly #authenticate: Authenticator;
  readonly #dependencies: ProviderQuotaDependencies;

  constructor(auth: GoogleAuth, dependencies: ProviderQuotaDependencies) {
    this.#authenticate = createConfiguredAuthenticator(
      auth,
      () => dependencies.quotaStore !== undefined,
    );
    this.#dependencies = dependencies;
  }

  #authenticated<T extends Promise<Response> | Response>(options: {
    readonly action: AuthenticatedAction<T>;
    readonly request: Request;
  }): Response | T {
    return this.#authenticate.authenticate(options.request, options.action);
  }

  #credential(
    userId: string,
    credentialId: string,
  ): Promise<ProviderCredentialAccess | undefined> {
    return this.#dependencies.readCredential(userId, credentialId);
  }

  async #requiredCredential(
    userId: string,
    credentialId: string,
  ): Promise<ProviderCredentialAccess> {
    const credential = await this.#credential(userId, credentialId);
    if (credential === undefined)
      throw new Error("Provider credential is unavailable");
    return credential;
  }

  read(request: Request, credentialId: string): Promise<Response> | Response {
    const methodError = requireRequestMethod(request, "GET");
    if (methodError !== undefined) return methodError;
    return this.#authenticated({
      request,
      action: async (user) => {
        let credential: ProviderCredentialAccess;
        try {
          credential = await this.#requiredCredential(user.id, credentialId);
        } catch {
          return createApiError("not_found", 404);
        }
        const setting = this.#dependencies.quotaStore?.read(
          user.id,
          credentialId,
        );
        const threshold =
          setting?.autoResetThresholdPercent ??
          DEFAULT_AUTO_RESET_THRESHOLD_PERCENT;
        try {
          let quota = await this.#dependencies.readQuota(credential, threshold);
          if (
            quota.resetSupported &&
            quota.bankedResetCount !== null &&
            quota.bankedResetCount > 0 &&
            quota.remainingPercent !== null &&
            quota.remainingPercent <= threshold
          ) {
            const window = quota.resetsAt ?? "unknown-window";
            const requestId = `auto-${credentialId}-${String(window)}`;
            await this.#consume(user, credentialId, requestId);
            quota = await this.#dependencies.readQuota(credential, threshold);
          }
          return createJsonResponse(quota);
        } catch {
          return createJsonResponse(quotaUnavailable(threshold));
        }
      },
    });
  }

  async setThreshold(
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
    return this.#authenticated({
      request,
      action: async (user) => {
        if ((await this.#credential(user.id, credentialId)) === undefined) {
          return createApiError("not_found", 404);
        }
        this.#dependencies.quotaStore?.setThreshold(
          user.id,
          credentialId,
          parsed,
          this.#dependencies.now(),
        );
        return createNoContentResponse();
      },
    });
  }

  async consume(request: Request, credentialId: string): Promise<Response> {
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
    return this.#authenticated({
      action: (user) => this.#consumeResponse(user, credentialId, requestId),
      request,
    });
  }

  async #consumeResponse(
    user: AuthenticatedUser,
    credentialId: string,
    requestId: string,
  ): Promise<Response> {
    try {
      const result = await this.#consume(user, credentialId, requestId);
      return result === undefined
        ? createApiError("reset_in_progress", 409)
        : createJsonResponse(result);
    } catch {
      return createApiError("provider_unavailable", 502);
    }
  }

  #resetResult(
    credential: ProviderCredentialAccess,
    threshold: number,
    outcome: ProviderQuotaResetOutcome,
    replayed: boolean,
  ): Promise<ProviderQuotaResetResult> {
    return this.#dependencies
      .readQuota(credential, threshold)
      .then((quota) => ({ outcome, quota, replayed }));
  }

  async #consume(
    user: AuthenticatedUser,
    credentialId: string,
    requestId: string,
  ): Promise<ProviderQuotaResetResult | undefined> {
    const credential = await this.#requiredCredential(user.id, credentialId);
    const quotaStore = this.#dependencies.quotaStore;
    if (quotaStore === undefined) {
      throw new Error("Quota settings are unavailable");
    }
    const setting = quotaStore.read(user.id, credentialId);
    const reservation = quotaStore.reserveReset(
      user.id,
      credentialId,
      requestId,
      this.#dependencies.now(),
    );
    if (reservation.replayedResult !== undefined) {
      if (!isResetOutcome(reservation.replayedResult)) {
        throw new Error("The stored reset result is invalid");
      }
      return this.#resetResult(
        credential,
        setting.autoResetThresholdPercent,
        reservation.replayedResult,
        true,
      );
    }
    if (!reservation.reserved) {
      return undefined;
    }
    const outcome = await this.#dependencies.resetQuota(
      credential,
      reservation.providerRequestId,
    );
    const completedAt = this.#dependencies.now();
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
    return await this.#resetResult(
      credential,
      setting.autoResetThresholdPercent,
      outcome,
      false,
    );
  }
}
