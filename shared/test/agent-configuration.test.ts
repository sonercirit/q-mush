import { describe, expect, test } from "vitest";
import {
  isOpenRouterProviderSelection,
  OPENROUTER_PROVIDER_NO_FALLBACKS_VALUE,
  openRouterProviderOrderValue,
  openRouterProviderSortValue,
  readOpenRouterProviderRouting,
} from "../agent-configuration.ts";

describe("OpenRouter provider routing selection", () => {
  test("keeps automatic and existing provider-tag values backward compatible", () => {
    expect(readOpenRouterProviderRouting(null)).toEqual({ type: "automatic" });
    expect(readOpenRouterProviderRouting("")).toEqual({ type: "automatic" });
    expect(readOpenRouterProviderRouting("google-vertex/us")).toEqual({
      tag: "google-vertex/us",
      type: "provider",
    });
    expect(isOpenRouterProviderSelection("google-vertex/us")).toBe(true);
  });

  test.each(["price", "throughput", "latency", "exacto"] as const)(
    "round trips the %s routing mode",
    (sort) => {
      const value = openRouterProviderSortValue(sort);
      expect(readOpenRouterProviderRouting(value)).toEqual({
        sort,
        type: "sort",
      });
      expect(isOpenRouterProviderSelection(value)).toBe(true);
    },
  );

  test("round trips fallback routing modes", () => {
    const ordered = openRouterProviderOrderValue("google-vertex/us");
    expect(readOpenRouterProviderRouting(ordered)).toEqual({
      tag: "google-vertex/us",
      type: "order",
    });
    expect(isOpenRouterProviderSelection(ordered)).toBe(true);
    expect(
      readOpenRouterProviderRouting(OPENROUTER_PROVIDER_NO_FALLBACKS_VALUE),
    ).toEqual({ type: "no_fallbacks" });
  });

  test("rejects reserved routing values that are not supported", () => {
    expect(
      readOpenRouterProviderRouting("q-mush-routing:future-mode"),
    ).toBeUndefined();
    expect(isOpenRouterProviderSelection("q-mush-routing:future-mode")).toBe(
      false,
    );
  });
});
