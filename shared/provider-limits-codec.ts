import { isRecord } from "./auth-model.ts";
import { isProviderId } from "./provider-credential-store.ts";
import type {
  ProviderLimitDimension,
  ProviderLimitSource,
  ProviderLimitState,
  ProviderLimitUnit,
} from "./provider-limits.ts";

const MAXIMUM_DIMENSIONS = 16;
const MAXIMUM_KEY_LENGTH = 100;
const MAXIMUM_LABEL_LENGTH = 200;

function provider(value: unknown) {
  return isProviderId(value) ? value : undefined;
}

function source(value: unknown): ProviderLimitSource | undefined {
  return value === "credential_metadata" ||
    value === "http_headers" ||
    value === "response_event" ||
    value === "websocket_event"
    ? value
    : undefined;
}

function unit(value: unknown): ProviderLimitUnit | undefined {
  return value === "credits" ||
    value === "percent" ||
    value === "requests" ||
    value === "tokens"
    ? value
    : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : (safeNumber(value) ?? undefined);
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function dimension(value: unknown): ProviderLimitDimension | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const key = value["key"];
  const label = value["label"];
  const limit = nullableNumber(value["limit"]);
  const remaining = nullableNumber(value["remaining"]);
  const resetAt = nullableNumber(value["resetAt"]);
  const parsedUnit = unit(value["unit"]);
  const rawUsed = value["used"];
  const used = rawUsed === undefined ? undefined : nullableNumber(rawUsed);
  return typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAXIMUM_KEY_LENGTH &&
    key.trim() === key &&
    typeof label === "string" &&
    label.length > 0 &&
    label.length <= MAXIMUM_LABEL_LENGTH &&
    label.trim() === label &&
    limit !== undefined &&
    remaining !== undefined &&
    resetAt !== undefined &&
    parsedUnit !== undefined &&
    (rawUsed === undefined || used !== undefined)
    ? {
        key,
        label,
        limit,
        remaining,
        resetAt,
        unit: parsedUnit,
        ...(used === undefined ? {} : { used }),
      }
    : undefined;
}

export function readProviderLimitState(
  value: unknown,
): ProviderLimitState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["status"] === "unavailable") {
    return { status: "unavailable" };
  }
  const rawDimensions = value["dimensions"];
  const observedAt = value["observedAt"];
  const parsedProvider = provider(value["provider"]);
  const parsedSource = source(value["source"]);
  const stale = value["stale"];
  if (
    value["status"] !== "available" ||
    !Array.isArray(rawDimensions) ||
    rawDimensions.length === 0 ||
    rawDimensions.length > MAXIMUM_DIMENSIONS ||
    typeof observedAt !== "number" ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    parsedProvider === undefined ||
    parsedSource === undefined ||
    typeof stale !== "boolean"
  ) {
    return undefined;
  }
  const dimensions: ProviderLimitDimension[] = [];
  const keys = new Set<string>();
  for (const rawDimension of rawDimensions) {
    const parsedDimension = dimension(rawDimension);
    if (parsedDimension === undefined || keys.has(parsedDimension.key)) {
      return undefined;
    }
    keys.add(parsedDimension.key);
    dimensions.push(parsedDimension);
  }
  return {
    dimensions,
    observedAt,
    provider: parsedProvider,
    source: parsedSource,
    stale,
    status: "available",
  };
}
