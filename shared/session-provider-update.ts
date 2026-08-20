import {
  isAgentModelId,
  readOpenRouterProviderTag,
} from "./agent-configuration.ts";
import { isRecord } from "./auth-model.ts";
import { isProviderId, type ProviderId } from "./provider-id.ts";
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
  const credentialId = readBoundedString(value["credentialId"], {
    maximumLength: 200,
  });
  const expectedGeneration = readNonNegativeSafeInteger(
    value["expectedGeneration"],
  );
  const model = value["model"];
  const openRouterProviderTag = readOpenRouterProviderTag(
    value["openRouterProviderTag"],
  );
  const provider = value["provider"];
  const sessionId = readBoundedString(value["sessionId"], {
    maximumLength: 200,
  });
  const workspaceId = readBoundedString(value["workspaceId"], {
    maximumLength: 200,
  });
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
