import {
  isAgentModelId,
  isOpenRouterProviderTag,
} from "./agent-configuration.ts";
import { isRecord } from "./auth-model.ts";
import { isProviderId, type ProviderId } from "./provider-credential-store.ts";
import { readBoundedString, readNonNegativeSafeInteger } from "./validation.ts";

export const SESSION_PROVIDER_CACHE_WARNING =
  "Changing the provider will drop the session cache.";

export interface SessionProviderUpdateSelection {
  readonly credentialId: string;
  readonly model: string;
  readonly openRouterProviderTag: string | null;
  readonly provider: ProviderId;
}

export interface SessionProviderUpdateInput extends SessionProviderUpdateSelection {
  readonly confirmedCacheDrop: boolean;
  readonly expectedGeneration: number;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export function readSessionProviderUpdateInput(
  value: unknown,
): SessionProviderUpdateInput | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 8) {
    return undefined;
  }
  const confirmedCacheDrop = value["confirmedCacheDrop"];
  const credentialId = readBoundedString(value["credentialId"], 200);
  const expectedGeneration = readNonNegativeSafeInteger(
    value["expectedGeneration"],
  );
  const model = value["model"];
  const openRouterProviderTagValue = value["openRouterProviderTag"];
  const provider = value["provider"];
  const sessionId = readBoundedString(value["sessionId"], 200);
  const workspaceId = readBoundedString(value["workspaceId"], 200);
  const openRouterProviderTag =
    openRouterProviderTagValue === null
      ? null
      : isOpenRouterProviderTag(openRouterProviderTagValue)
        ? openRouterProviderTagValue
        : undefined;
  if (
    typeof confirmedCacheDrop !== "boolean" ||
    credentialId === undefined ||
    expectedGeneration === undefined ||
    !isAgentModelId(model) ||
    !isProviderId(provider) ||
    sessionId === undefined ||
    workspaceId === undefined ||
    openRouterProviderTag === undefined ||
    (provider !== "openrouter" && openRouterProviderTag !== null)
  ) {
    return undefined;
  }
  return {
    confirmedCacheDrop,
    credentialId,
    expectedGeneration,
    model,
    openRouterProviderTag,
    provider,
    sessionId,
    workspaceId,
  };
}

export function sessionProviderSelectionMatches(
  current: SessionProviderUpdateSelection,
  target: SessionProviderUpdateSelection,
): boolean {
  return (
    current.credentialId === target.credentialId &&
    current.model === target.model &&
    current.openRouterProviderTag === target.openRouterProviderTag &&
    current.provider === target.provider
  );
}
