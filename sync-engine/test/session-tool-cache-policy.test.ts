import { describe, expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { sessionToolCachePreview } from "../session-tool-cache-policy.ts";
import { sessionToolCacheCapability } from "../session-tool-capability.ts";

const OPENROUTER_CACHE_CONTEXT = {
  credentialSource: "api_key" as const,
  model: "openai/gpt-5",
  provider: "openrouter" as const,
  tools: ["read"] as const,
};

describe("session tool cache policy", () => {
  test("preserves cache only for the explicitly supported Responses capability", () => {
    expect(
      sessionToolCacheCapability({
        credentialSource: "oauth",
        model: "gpt-5-codex",
        provider: "openai",
        tools: AGENT_SESSION_TOOL_NAMES,
      }),
    ).toEqual({
      preservesDynamicToolCache: true,
      strategy: "openai_allowed_tools",
    });
    expect(
      sessionToolCacheCapability({
        credentialSource: "api_key",
        model: "gpt-5",
        provider: "openai",
        tools: ["read"],
      }).preservesDynamicToolCache,
    ).toBe(false);
    expect(
      sessionToolCacheCapability(OPENROUTER_CACHE_CONTEXT)
        .preservesDynamicToolCache,
    ).toBe(false);
  });

  test("requires a clear warning before a cache-unassured change", () => {
    const warning = sessionToolCachePreview(
      { generation: 7, tools: ["read"] },
      ["read", "bash"],
      {
        ...OPENROUTER_CACHE_CONTEXT,
        tools: ["read", "bash"],
      },
    );
    expect(warning.cacheDisposition).toBe("warning_required");
    expect(warning.currentGeneration).toBe(7);
    expect(warning.warning).toContain("might drop");

    expect(
      sessionToolCachePreview(
        { generation: 7, tools: ["read"] },
        ["read"],
        OPENROUTER_CACHE_CONTEXT,
      ).cacheDisposition,
    ).toBe("preserved");
  });
});
