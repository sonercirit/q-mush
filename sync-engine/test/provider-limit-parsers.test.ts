import { describe, expect, test } from "vitest";
import {
  parseCodexLimitEvent,
  parseOpenRouterMetadataLimits,
  parseProviderLimitHeaders,
} from "../../sync-engine/provider-limit-parsers.ts";

const OBSERVED_AT = 1_700_000_000_000;

describe("provider limit header adapters", () => {
  test("reads documented OpenRouter key credit and period usage metadata", () => {
    expect(
      parseOpenRouterMetadataLimits(
        {
          data: {
            label: "secret label is ignored",
            limit: 50,
            limit_remaining: 0,
            limit_reset: "monthly",
            usage: 50,
            usage_daily: 1.25,
            usage_monthly: 20,
            usage_weekly: 4,
          },
        },
        OBSERVED_AT,
      ),
    ).toEqual({
      dimensions: [
        {
          key: "key_credits",
          label: "Key credits",
          limit: 50,
          remaining: 0,
          resetAt: null,
          unit: "credits",
          used: 50,
        },
        {
          key: "daily_usage",
          label: "Current-day usage",
          limit: null,
          remaining: null,
          resetAt: null,
          unit: "credits",
          used: 1.25,
        },
        {
          key: "weekly_usage",
          label: "Current-week usage",
          limit: null,
          remaining: null,
          resetAt: null,
          unit: "credits",
          used: 4,
        },
        {
          key: "monthly_usage",
          label: "Current-month usage",
          limit: null,
          remaining: null,
          resetAt: null,
          unit: "credits",
          used: 20,
        },
      ],
      observedAt: OBSERVED_AT,
      provider: "openrouter",
      source: "credential_metadata",
    });
  });

  test("reads case-insensitive OpenAI request and token limit families", () => {
    const headers = new Headers({
      "X-RateLimit-Limit-Requests": "500",
      "x-ratelimit-limit-tokens": "30000",
      "X-RateLimit-Remaining-Requests": "0",
      "x-ratelimit-remaining-tokens": "12345",
      "X-RateLimit-Reset-Requests": "1m2.5s",
      "x-ratelimit-reset-tokens": "250ms",
      authorization: "Bearer secret",
    });

    const parsed = parseProviderLimitHeaders(
      "openai",
      "api_key",
      headers,
      OBSERVED_AT,
    );
    expect(parsed?.provider).toBe("openai");
    expect(parsed?.source).toBe("http_headers");
    expect(parsed?.observedAt).toBe(OBSERVED_AT);
    expect(parsed?.dimensions).toEqual([
      {
        key: "requests",
        label: "Requests",
        limit: 500,
        remaining: 0,
        resetAt: OBSERVED_AT + 62_500,
        unit: "requests",
      },
      {
        key: "tokens",
        label: "Tokens",
        limit: 30_000,
        remaining: 12_345,
        resetAt: OBSERVED_AT + 250,
        unit: "tokens",
      },
    ]);
  });

  test("reads Codex rolling windows and safe numeric credit balance", () => {
    const headers = new Headers({
      "x-codex-credits-balance": "12.50",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-primary-reset-at": "1700000900",
      "x-codex-primary-used-percent": "25",
      "x-codex-primary-window-minutes": "15",
      "x-codex-secondary-reset-at": "1700604800",
      "x-codex-secondary-used-percent": "100",
      "x-codex-secondary-window-minutes": "10080",
    });

    const parsed = parseProviderLimitHeaders(
      "openai",
      "oauth",
      new Headers(headers),
      OBSERVED_AT,
    );
    expect(parsed?.dimensions).toEqual([
      {
        key: "codex_primary_15m",
        label: "15-minute usage",
        limit: 100,
        remaining: 75,
        resetAt: 1_700_000_900_000,
        unit: "percent",
      },
      {
        key: "codex_secondary_1w",
        label: "1-week usage",
        limit: 100,
        remaining: 0,
        resetAt: 1_700_604_800_000,
        unit: "percent",
      },
      {
        key: "codex_credits",
        label: "Credits",
        limit: null,
        remaining: 12.5,
        resetAt: null,
        unit: "credits",
      },
    ]);
    expect(parsed).toMatchObject({
      observedAt: OBSERVED_AT,
      provider: "openai",
      source: "http_headers",
    });
  });

  test("reads OpenRouter platform limit errors without assigning an invented unit", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "80",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1700000060000",
    });

    expect(
      parseProviderLimitHeaders("openrouter", "oauth", headers, OBSERVED_AT),
    ).toEqual({
      dimensions: [
        {
          key: "provider_limit",
          label: "Provider limit",
          limit: 80,
          remaining: 0,
          resetAt: 1_700_000_060_000,
          unit: "requests",
        },
      ],
      observedAt: OBSERVED_AT,
      provider: "openrouter",
      source: "http_headers",
    });
  });

  test("uses Retry-After as reset-only evidence on a 429", () => {
    const headers = new Headers({ "retry-after": "5" });

    expect(
      parseProviderLimitHeaders(
        "openrouter",
        "api_key",
        headers,
        OBSERVED_AT,
        429,
      ),
    ).toMatchObject({
      dimensions: [
        {
          key: "provider_limit",
          limit: null,
          remaining: null,
          resetAt: OBSERVED_AT + 5_000,
        },
      ],
    });
  });

  test("ignores malformed, negative, overflowing, and secret headers", () => {
    const headers = new Headers({
      "openai-organization": "org-secret",
      "set-cookie": "session=secret",
      "x-ratelimit-limit-requests": "9007199254740992",
      "x-ratelimit-remaining-requests": "-1",
      "x-ratelimit-reset-requests": "tomorrow",
      "x-ratelimit-limit-tokens": "   ",
    });

    const malformed = parseProviderLimitHeaders(
      "openai",
      "api_key",
      new Headers(headers),
      OBSERVED_AT,
    );
    expect(malformed).toBeNull();
    expect(JSON.stringify(malformed)).not.toContain("secret");
  });
});

describe("Codex Responses event adapter", () => {
  test("reads documented WebSocket rate-limit events", () => {
    expect(
      parseCodexLimitEvent(
        {
          credits: { balance: "3", has_credits: true, unlimited: false },
          rate_limits: {
            primary: {
              reset_at: 1_700_003_600,
              used_percent: 42,
              window_minutes: 60,
            },
            secondary: null,
          },
          type: "codex.rate_limits",
        },
        OBSERVED_AT,
      ),
    ).toMatchObject({
      dimensions: [
        {
          key: "codex_primary_1h",
          limit: 100,
          remaining: 58,
          resetAt: 1_700_003_600_000,
        },
        { key: "codex_credits", limit: null, remaining: 3 },
      ],
      source: "websocket_event",
    });
  });

  test("ignores unrelated events and impossible percentages", () => {
    expect(
      parseCodexLimitEvent({ type: "response.created" }, OBSERVED_AT),
    ).toBe(null);
    expect(
      parseCodexLimitEvent(
        {
          rate_limits: { primary: { used_percent: 101 } },
          type: "codex.rate_limits",
        },
        OBSERVED_AT,
      ),
    ).toBeNull();
  });
});
