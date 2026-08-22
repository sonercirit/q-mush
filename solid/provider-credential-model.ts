import { isRecord } from "../shared/auth-model.ts";
import type { ScopedConnectionSummary } from "../shared/connection-model.ts";
import type {
  ProviderQuotaResetOutcome,
  ProviderQuotaSnapshot,
} from "../shared/provider-quota.ts";
import { workspaceIdsAreValid } from "./connection-client.ts";

export interface ProviderCredential extends ScopedConnectionSummary {
  readonly accountId: string | null;
  readonly apiFormat?: "anthropic" | "openai";
  readonly baseUrl?: string;
  readonly label: string;
  readonly requiresReauthentication?: boolean;
  readonly source: "api_key" | "oauth";
}

export type ProviderCredentialAddInput = readonly [
  apiKey: string,
  label?: string,
  baseUrl?: string,
  apiFormat?: string,
];

interface ProviderViewStateBase {
  readonly credentials: readonly ProviderCredential[] | undefined;
  readonly error: string | undefined;
  readonly quotaLoadingIds: readonly string[];
  readonly quotaNotice:
    | {
        readonly credentialId: string;
        readonly outcome: ProviderQuotaResetOutcome;
      }
    | undefined;
  readonly quotaPendingId: string | undefined;
  readonly quotas: Readonly<Record<string, ProviderQuotaSnapshot>>;
  readonly quotaThresholdPendingId: string | undefined;
  readonly removingId: string | undefined;
  readonly savePending: boolean;
  readonly sessionReassignmentNotice: string | undefined;
  readonly settingDefaultId: string | undefined;
}

export function createProviderViewState(
  credentials: readonly ProviderCredential[] | undefined,
): ProviderViewStateBase {
  return {
    credentials,
    error: undefined,
    quotaLoadingIds: [],
    quotaNotice: undefined,
    quotaPendingId: undefined,
    quotas: {},
    quotaThresholdPendingId: undefined,
    removingId: undefined,
    savePending: false,
    sessionReassignmentNotice: undefined,
    settingDefaultId: undefined,
  };
}

export type ProviderViewState = ProviderViewStateBase;

function readCredential(
  value: unknown,
  providerName: string,
): ProviderCredential {
  if (!isRecord(value)) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  const accountId = value["accountId"];
  const apiFormat = value["apiFormat"];
  const baseUrl = value["baseUrl"];
  const id = value["id"];
  const label = value["label"];
  const isDefault = value["isDefault"];
  const isGlobal = value["isGlobal"];
  const requiresReauthentication = value["requiresReauthentication"];
  const source = value["source"];
  const workspaceIds = value["workspaceIds"];

  if (
    requiresReauthentication !== undefined &&
    typeof requiresReauthentication !== "boolean"
  ) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  if (
    (accountId !== null && typeof accountId !== "string") ||
    (apiFormat !== undefined &&
      apiFormat !== "anthropic" &&
      apiFormat !== "openai") ||
    (baseUrl !== undefined && typeof baseUrl !== "string") ||
    typeof id !== "string" ||
    typeof isDefault !== "boolean" ||
    (isGlobal !== undefined && typeof isGlobal !== "boolean") ||
    typeof label !== "string" ||
    (source !== "api_key" && source !== "oauth") ||
    !workspaceIdsAreValid(workspaceIds)
  ) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  return {
    accountId,
    ...(apiFormat === undefined ? {} : { apiFormat }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    id,
    isDefault,
    ...(isGlobal === undefined ? {} : { isGlobal }),
    label,
    ...(requiresReauthentication === undefined
      ? {}
      : { requiresReauthentication }),
    source,
    ...(workspaceIds === undefined ? {} : { workspaceIds }),
  };
}

export function readProviderCredentials(
  value: unknown,
  providerName: string,
): readonly ProviderCredential[] {
  if (!isRecord(value) || !Array.isArray(value["credentials"])) {
    throw new Error(
      `The server returned an invalid ${providerName} credential list`,
    );
  }

  return value["credentials"].map((credential) =>
    readCredential(credential, providerName),
  );
}
