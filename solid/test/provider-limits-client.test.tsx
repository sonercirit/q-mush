import { describe, expect, test } from "vitest";
import type {
  ProviderLimitDimension,
  ProviderLimitSource,
  ProviderLimitState,
} from "../../shared/provider-limits.ts";
import { RemainingLimits } from "../../solid/provider-limits-client.tsx";
import { renderSolidToString } from "./render-solid.tsx";

const NOW = 1_700_000_000_000;

function render(limits: ProviderLimitState): string {
  return renderSolidToString(() => (
    <RemainingLimits limits={limits} now={NOW} />
  ));
}

function availableLimits(
  dimensions: readonly ProviderLimitDimension[],
  options: {
    readonly observedAt?: number;
    readonly provider?: "openai" | "openrouter";
    readonly source?: ProviderLimitSource;
    readonly stale?: boolean;
  } = {},
): ProviderLimitState {
  return {
    dimensions,
    observedAt: options.observedAt ?? NOW,
    provider: options.provider ?? "openai",
    source: options.source ?? "http_headers",
    stale: options.stale ?? false,
    status: "available",
  };
}

describe("remaining limits", () => {
  test("distinguishes unavailable metadata from zero remaining", () => {
    expect(render({ status: "unavailable" })).toContain(
      "has not exposed limit metadata",
    );
    const html = render(
      availableLimits([
        {
          key: "requests",
          label: "Requests",
          limit: 100,
          remaining: 0,
          resetAt: NOW + 60_000,
          unit: "requests",
        },
      ]),
    );
    expect(html).toContain("0 of 100 remaining");
    expect(html).toContain("Critical: nearly exhausted");
    expect(html).toContain("<progress");
    expect(html).toContain('value="0"');
    expect(html).toContain("0% remaining");
    expect(html).toContain("Resets in 1m");
    expect(html).not.toContain("has not exposed");
  });

  test("renders partial values and stale explanations", () => {
    const html = render(
      availableLimits(
        [
          {
            key: "provider_limit",
            label: "Provider limit",
            limit: null,
            remaining: null,
            resetAt: NOW + 3_600_000,
            unit: "requests",
          },
          {
            key: "credits",
            label: "Credits",
            limit: null,
            remaining: 2.5,
            resetAt: null,
            unit: "credits",
          },
        ],
        {
          observedAt: NOW - 20 * 60_000,
          provider: "openrouter",
          source: "response_event",
          stale: true,
        },
      ),
    );
    expect(html).toContain("Remaining amount unavailable");
    expect(html).toContain("$2.50 remaining");
    expect(html).toContain("Stale observation");
    expect(html).toContain("Provider response event");
  });

  test("includes accessible progress semantics and textual warning state", () => {
    const html = render(
      availableLimits([
        {
          key: "tokens",
          label: "Tokens",
          limit: 1_000,
          remaining: 150,
          resetAt: null,
          unit: "tokens",
        },
      ]),
    );
    expect(html).toContain("<progress");
    expect(html).toContain('aria-label="Tokens remaining"');
    expect(html).toContain("Warning: running low");
    expect(html).toContain("15% remaining");
  });
});
