import { isRecord } from "../shared/auth-model.ts";
import type { ProviderQuotaSnapshot } from "../shared/provider-quota.ts";
import { readFiniteNumber, requireRecord } from "../shared/validation.ts";

interface QuotaWindow {
  readonly estimatedExhaustionAt: number | null;
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
}

function percent(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && number >= 0 && number <= 100
    ? number
    : undefined;
}

function timestampMilliseconds(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number === undefined || number <= 0 ? null : Math.round(number * 1000);
}

function readWindow(value: unknown, now: number): QuotaWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const used = percent(value["used_percent"]);
  if (used === undefined) {
    return undefined;
  }
  const resetsAt = timestampMilliseconds(value["reset_at"]);
  const windowSeconds = readFiniteNumber(value["limit_window_seconds"]);
  const remainingPercent = 100 - used;
  let estimatedExhaustionAt: number | null = null;
  if (remainingPercent <= 0) {
    estimatedExhaustionAt = now;
  } else if (resetsAt !== null && windowSeconds !== undefined && used > 0) {
    const startedAt = resetsAt - windowSeconds * 1000;
    const elapsed = now - startedAt;
    if (elapsed > 0) {
      estimatedExhaustionAt = now + (elapsed * remainingPercent) / used;
    }
  }
  return { estimatedExhaustionAt, remainingPercent, resetsAt };
}

function earliestExhaustion(
  windows: readonly QuotaWindow[],
  now: number,
): number | null {
  const estimates = windows
    .map(({ estimatedExhaustionAt, remainingPercent }) =>
      remainingPercent <= 0 ? now : estimatedExhaustionAt,
    )
    .filter((estimate): estimate is number => estimate !== null);
  return estimates.length === 0 ? null : Math.min(...estimates);
}

export function readCodexQuota(
  value: unknown,
  threshold: number,
  now: number,
): ProviderQuotaSnapshot {
  const record = requireRecord(
    value,
    "OpenAI returned invalid Codex quota data",
  );
  const rateLimit = requireRecord(
    record["rate_limit"],
    "OpenAI returned invalid Codex quota data",
  );
  const windows = [
    readWindow(rateLimit["primary_window"], now),
    readWindow(rateLimit["secondary_window"], now),
  ].filter((window): window is QuotaWindow => window !== undefined);
  if (windows.length === 0) {
    throw new Error("OpenAI returned invalid Codex quota windows");
  }
  const resetCredits = record["rate_limit_reset_credits"];
  const availableCount = isRecord(resetCredits)
    ? readFiniteNumber(resetCredits["available_count"])
    : undefined;
  const limiting = windows.reduce((lowest, window) =>
    window.remainingPercent < lowest.remainingPercent ? window : lowest,
  );
  return {
    autoResetThresholdPercent: threshold,
    bankedResetCount:
      availableCount !== undefined &&
      Number.isSafeInteger(availableCount) &&
      availableCount >= 0
        ? availableCount
        : null,
    estimatedExhaustionAt: earliestExhaustion(windows, now),
    remainingPercent: limiting.remainingPercent,
    resetSupported: true,
    resetsAt: limiting.resetsAt,
    source: "ChatGPT Codex usage windows",
  };
}

function durationMilliseconds(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu;
  let total = 0;
  let consumed = "";
  for (const match of value.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : 86_400_000;
    total += amount * multiplier;
    consumed += match[0];
  }
  return consumed === value && total > 0 ? Math.round(total) : null;
}

export function readOpenAiKeyQuota(
  headers: Headers,
  threshold: number,
  now: number,
): ProviderQuotaSnapshot {
  const limit = Number(headers.get("x-ratelimit-limit-requests"));
  const remaining = Number(headers.get("x-ratelimit-remaining-requests"));
  const valid =
    Number.isFinite(limit) &&
    limit > 0 &&
    Number.isFinite(remaining) &&
    remaining >= 0;
  const remainingPercent = valid
    ? Math.min(100, (remaining / limit) * 100)
    : null;
  const resetDuration = durationMilliseconds(
    headers.get("x-ratelimit-reset-requests"),
  );
  const resetAt = resetDuration === null ? null : now + resetDuration;
  return {
    autoResetThresholdPercent: threshold,
    bankedResetCount: null,
    estimatedExhaustionAt:
      remainingPercent !== null && remainingPercent <= 0 ? now : null,
    remainingPercent,
    resetSupported: false,
    resetsAt: resetAt,
    source: "OpenAI API request-rate headers",
  };
}

interface OpenRouterPeriod {
  readonly resetsAt: number;
  readonly startedAt: number;
}

function openRouterPeriod(
  kind: unknown,
  now: number,
): OpenRouterPeriod | undefined {
  if (kind !== "daily" && kind !== "weekly" && kind !== "monthly") {
    return undefined;
  }
  const current = new Date(now);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();
  if (kind === "daily") {
    return {
      resetsAt: Date.UTC(year, month, day + 1),
      startedAt: Date.UTC(year, month, day),
    };
  }
  if (kind === "weekly") {
    const sinceMonday = (current.getUTCDay() + 6) % 7;
    return {
      resetsAt: Date.UTC(year, month, day + 7 - sinceMonday),
      startedAt: Date.UTC(year, month, day - sinceMonday),
    };
  }
  return {
    resetsAt: Date.UTC(year, month + 1, 1),
    startedAt: Date.UTC(year, month, 1),
  };
}

function estimatedCreditExhaustion(
  period: OpenRouterPeriod | undefined,
  now: number,
  spent: number,
  remaining: number,
): number | null {
  if (remaining <= 0) {
    return now;
  }
  if (period === undefined || spent <= 0) {
    return null;
  }
  const elapsed = now - period.startedAt;
  return elapsed <= 0 ? null : now + (elapsed * remaining) / spent;
}

export function readOpenRouterQuota(
  value: unknown,
  threshold: number,
  now: number,
): ProviderQuotaSnapshot {
  const data = requireRecord(
    isRecord(value) ? value["data"] : undefined,
    "OpenRouter returned invalid key quota data",
  );
  const limit = readFiniteNumber(data["limit"]);
  const remaining = readFiniteNumber(data["limit_remaining"]);
  const remainingPercent =
    limit !== undefined && limit > 0 && remaining !== undefined
      ? Math.max(0, Math.min(100, (remaining / limit) * 100))
      : null;
  const period = openRouterPeriod(data["limit_reset"], now);
  const spent =
    limit !== undefined && remaining !== undefined
      ? Math.max(0, limit - remaining)
      : 0;
  return {
    autoResetThresholdPercent: threshold,
    bankedResetCount: null,
    estimatedExhaustionAt:
      remaining === undefined
        ? null
        : estimatedCreditExhaustion(period, now, spent, remaining),
    remainingPercent,
    resetSupported: false,
    resetsAt: period?.resetsAt ?? null,
    source: "OpenRouter API key credit limit",
  };
}
