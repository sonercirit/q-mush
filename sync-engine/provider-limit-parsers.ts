import { isRecord } from "../shared/auth-model.ts";
import type {
  ProviderCredentialSource,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type {
  ProviderLimitDimension,
  ProviderLimitObservation,
} from "../shared/provider-limits.ts";

const MAXIMUM_TIMESTAMP_MILLISECONDS = 8_640_000_000_000_000;

function safeNumber(value: unknown): number | null {
  if (
    typeof value === "string" &&
    (value.length === 0 || value.trim() !== value)
  ) {
    return null;
  }
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : null;
}

function safeNonnegativeNumber(value: string | null): number | null {
  return safeNumber(value);
}

function safePercent(value: unknown): number | null {
  const parsed = safeNumber(value);
  return parsed !== null && parsed <= 100 ? parsed : null;
}

function epochMilliseconds(value: unknown): number | null {
  const parsed = safeNumber(value);
  if (parsed === null) {
    return null;
  }

  const milliseconds = parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
  return Number.isSafeInteger(milliseconds) &&
    milliseconds <= MAXIMUM_TIMESTAMP_MILLISECONDS
    ? milliseconds
    : null;
}

const DURATION_PART = /([\d.]+)\s*(ms|s|m|h|d)/giu;
const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  ms: 1,
  s: 1_000,
};

function durationMilliseconds(value: string | null): number | null {
  if (value === null || value.length === 0) {
    return null;
  }

  let consumed = "";
  let total = 0;
  for (const match of value.matchAll(DURATION_PART)) {
    const amount = safeNumber(match[1]);
    const unit = match[2]?.toLowerCase();
    const multiplier =
      unit === undefined ? undefined : DURATION_MULTIPLIERS[unit];
    if (amount === null || multiplier === undefined) {
      return null;
    }
    consumed += match[0].replaceAll(/\s/gu, "");
    total += amount * multiplier;
  }

  return consumed === value.replaceAll(/\s/gu, "") &&
    Number.isSafeInteger(total) &&
    total >= 0
    ? total
    : null;
}

function durationResetAt(
  value: string | null,
  observedAt: number,
): number | null {
  const duration = durationMilliseconds(value);
  if (duration === null) {
    return null;
  }

  const resetAt = observedAt + duration;
  return Number.isSafeInteger(resetAt) &&
    resetAt <= MAXIMUM_TIMESTAMP_MILLISECONDS
    ? resetAt
    : null;
}

function retryAfterResetAt(
  value: string | null,
  observedAt: number,
): number | null {
  if (value === null) {
    return null;
  }

  const seconds = safeNonnegativeNumber(value);
  if (seconds !== null) {
    const resetAt = observedAt + seconds * 1_000;
    return Number.isSafeInteger(resetAt) ? resetAt : null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= MAXIMUM_TIMESTAMP_MILLISECONDS
    ? parsed
    : null;
}

function dimension(options: ProviderLimitDimension): ProviderLimitDimension {
  return options;
}

function openAiApiDimensions(
  headers: Headers,
  observedAt: number,
): readonly ProviderLimitDimension[] {
  const dimensions: ProviderLimitDimension[] = [];
  for (const item of [
    { key: "requests", label: "Requests", unit: "requests" as const },
    { key: "tokens", label: "Tokens", unit: "tokens" as const },
  ]) {
    const limit = safeNonnegativeNumber(
      headers.get(`x-ratelimit-limit-${item.key}`),
    );
    const remaining = safeNonnegativeNumber(
      headers.get(`x-ratelimit-remaining-${item.key}`),
    );
    const resetAt = durationResetAt(
      headers.get(`x-ratelimit-reset-${item.key}`),
      observedAt,
    );
    if (limit !== null || remaining !== null || resetAt !== null) {
      dimensions.push(dimension({ ...item, limit, remaining, resetAt }));
    }
  }
  return dimensions;
}

function windowText(
  minutes: number | null,
  fallback: string,
  suffixes: readonly string[],
): string {
  if (minutes === null) {
    return fallback;
  }
  const [weekSuffix = "", daySuffix = "", hourSuffix = "", minuteSuffix = ""] =
    suffixes;
  for (const [duration, suffix] of [
    [10_080, weekSuffix],
    [1_440, daySuffix],
    [60, hourSuffix],
  ] as const) {
    if (minutes % duration === 0) {
      return `${String(minutes / duration)}${suffix}`;
    }
  }
  return `${String(minutes)}${minuteSuffix}`;
}

function windowLabel(minutes: number | null, fallback: string): string {
  const labels = [
    "-week usage",
    "-day usage",
    "-hour usage",
    "-minute usage",
  ] as const;
  return windowText(minutes, fallback, labels);
}

function windowKey(minutes: number | null, fallback: string): string {
  const suffixes = ["w", "d", "h", "m"] as const;
  return windowText(minutes, fallback, suffixes);
}

function codexWindow(
  key: "primary" | "secondary",
  usedValue: unknown,
  minutesValue: unknown,
  resetValue: unknown,
): ProviderLimitDimension | null {
  const used = safePercent(usedValue);
  if (used === null) {
    return null;
  }

  const minutes = safeNumber(minutesValue);
  const safeMinutes =
    minutes !== null && Number.isSafeInteger(minutes) ? minutes : null;
  return dimension({
    key: `codex_${key}_${windowKey(safeMinutes, "window")}`,
    label: windowLabel(
      safeMinutes,
      `${key === "primary" ? "Primary" : "Secondary"} usage`,
    ),
    limit: 100,
    remaining: 100 - used,
    resetAt: epochMilliseconds(resetValue),
    unit: "percent",
  });
}

function codexCredits(value: unknown): ProviderLimitDimension | null {
  if (!isRecord(value) || value["unlimited"] === true) {
    return null;
  }
  const balance = safeNumber(value["balance"]);
  return balance === null
    ? null
    : dimension({
        key: "codex_credits",
        label: "Credits",
        limit: null,
        remaining: balance,
        resetAt: null,
        unit: "credits",
      });
}

function addDimension(
  dimensions: ProviderLimitDimension[],
  candidate: ProviderLimitDimension | null,
): void {
  if (candidate !== null) {
    dimensions.push(candidate);
  }
}

function addCodexWindows(
  dimensions: ProviderLimitDimension[],
  readWindow: (key: "primary" | "secondary") => ProviderLimitDimension | null,
): void {
  for (const key of ["primary", "secondary"] as const) {
    addDimension(dimensions, readWindow(key));
  }
}

function codexHeaderDimensions(
  headers: Headers,
): readonly ProviderLimitDimension[] {
  const dimensions: ProviderLimitDimension[] = [];
  addCodexWindows(dimensions, (key) =>
    codexWindow(
      key,
      headers.get(`x-codex-${key}-used-percent`),
      headers.get(`x-codex-${key}-window-minutes`),
      headers.get(`x-codex-${key}-reset-at`),
    ),
  );
  addDimension(
    dimensions,
    codexCredits({
      balance: headers.get("x-codex-credits-balance"),
      has_credits: headers.get("x-codex-credits-has-credits") === "true",
      unlimited: headers.get("x-codex-credits-unlimited") === "true",
    }),
  );
  return dimensions;
}

function openRouterDimensions(
  headers: Headers,
  observedAt: number,
  status: number,
): readonly ProviderLimitDimension[] {
  const limit = safeNonnegativeNumber(headers.get("x-ratelimit-limit"));
  const remaining = safeNonnegativeNumber(headers.get("x-ratelimit-remaining"));
  const resetAt = epochMilliseconds(headers.get("x-ratelimit-reset"));
  const retryAt =
    status === 429
      ? retryAfterResetAt(headers.get("retry-after"), observedAt)
      : null;
  return limit === null &&
    remaining === null &&
    resetAt === null &&
    retryAt === null
    ? []
    : [
        dimension({
          key: "provider_limit",
          label: "Provider limit",
          limit,
          remaining,
          resetAt: resetAt ?? retryAt,
          unit: "requests",
        }),
      ];
}

function observation(
  dimensions: readonly ProviderLimitDimension[],
  observedAt: number,
  provider: ProviderId,
  source: ProviderLimitObservation["source"],
): ProviderLimitObservation | null {
  return dimensions.length === 0
    ? null
    : { dimensions, observedAt, provider, source };
}

function readOpenRouterMetadataLimits(
  data: Readonly<Record<string, unknown>>,
  observedAt: number,
): ProviderLimitObservation | null {
  const limit = safeNumber(data["limit"]);
  const remaining = safeNumber(data["limit_remaining"]);
  const usage = safeNumber(data["usage"]);
  const usageDaily = safeNumber(data["usage_daily"]);
  const usageWeekly = safeNumber(data["usage_weekly"]);
  const usageMonthly = safeNumber(data["usage_monthly"]);
  const dimensions: ProviderLimitDimension[] = [];
  if (limit !== null || remaining !== null || usage !== null) {
    dimensions.push({
      key: "key_credits",
      label: "Key credits",
      limit,
      remaining,
      resetAt: null,
      unit: "credits",
      ...(usage === null ? {} : { used: usage }),
    });
  }
  for (const [key, label, used] of [
    ["daily_usage", "Current-day usage", usageDaily],
    ["weekly_usage", "Current-week usage", usageWeekly],
    ["monthly_usage", "Current-month usage", usageMonthly],
  ] as const) {
    if (used !== null) {
      dimensions.push({
        key,
        label,
        limit: null,
        remaining: null,
        resetAt: null,
        unit: "credits",
        used,
      });
    }
  }
  return observation(
    dimensions,
    observedAt,
    "openrouter",
    "credential_metadata",
  );
}

function readCodexLimitContainer(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || value["type"] !== "codex.rate_limits") {
    return undefined;
  }
  return isRecord(value["rate_limits"]) ? value["rate_limits"] : {};
}

export function parseOpenRouterMetadataLimits(
  value: unknown,
  observedAt: number,
): ProviderLimitObservation | null {
  if (!isRecord(value) || !isRecord(value["data"])) {
    return null;
  }
  return readOpenRouterMetadataLimits(value["data"], observedAt);
}

export function parseProviderLimitHeaders(
  provider: ProviderId,
  credentialSource: ProviderCredentialSource,
  headers: Headers,
  observedAt: number,
  status = 200,
): ProviderLimitObservation | null {
  const dimensions =
    provider === "openrouter"
      ? openRouterDimensions(headers, observedAt, status)
      : credentialSource === "oauth"
        ? codexHeaderDimensions(headers)
        : openAiApiDimensions(headers, observedAt);

  return observation(dimensions, observedAt, provider, "http_headers");
}

export function parseCodexLimitEvent(
  value: unknown,
  observedAt: number,
): ProviderLimitObservation | null {
  const limits = readCodexLimitContainer(value);
  if (limits === undefined) {
    return null;
  }
  const dimensions: ProviderLimitDimension[] = [];
  addCodexWindows(dimensions, (key) => {
    const raw = limits[key];
    return isRecord(raw)
      ? codexWindow(
          key,
          raw["used_percent"],
          raw["window_minutes"],
          raw["reset_at"],
        )
      : null;
  });
  const event = isRecord(value) ? value : {};
  addDimension(dimensions, codexCredits(event["credits"]));

  return observation(dimensions, observedAt, "openai", "websocket_event");
}
