import { describe, expect, test } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import {
  promptCacheBreakpoints,
  withAnthropicReplayCacheControl,
  withPromptCacheControl,
} from "../../sync-engine/provider-prompt-cache.ts";

function userMessage(content: string): AgentConversationMessage {
  return { content, role: "user" };
}

function breakpointsOf(contents: readonly string[]): readonly number[] {
  return [...promptCacheBreakpoints(contents.map(userMessage))].sort();
}

describe("prompt cache breakpoints", () => {
  test("marks the final message and a rolling predecessor", () => {
    expect(breakpointsOf(["first", "second", "third", "fourth"])).toEqual([
      1, 3,
    ]);
  });

  test("skips empty contents when picking cacheable indexes", () => {
    expect(breakpointsOf(["first", "", "third", ""])).toEqual([0, 2]);
  });

  test("collapses to a single breakpoint on a short transcript", () => {
    expect([...promptCacheBreakpoints([userMessage("only")])]).toEqual([0]);
    expect([...promptCacheBreakpoints([])]).toEqual([]);
    expect([...promptCacheBreakpoints([userMessage("")])]).toEqual([]);
  });
});

describe("prompt cache control markers", () => {
  test("scans backward to documented replay block placements", () => {
    const parts = [
      { text: "Answer", type: "text" as const },
      {
        content: [],
        tool_use_id: "server-call",
        type: "web_search_tool_result" as const,
      },
      { data: "redacted", type: "redacted_thinking" as const },
    ];

    expect(withAnthropicReplayCacheControl(parts)).toEqual([
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "Answer",
        type: "text",
      },
      parts[1],
      parts[2],
    ]);
  });

  test("marks tool_use but no unsupported replay type", () => {
    const tool = {
      id: "call-1",
      input: {},
      name: "read",
      type: "tool_use",
    } as const;
    expect(withAnthropicReplayCacheControl([tool])).toEqual([
      { ...tool, cache_control: { ttl: "1h", type: "ephemeral" } },
    ]);
    expect(
      withAnthropicReplayCacheControl([
        { file_id: "file-1", type: "container_upload" },
      ]),
    ).toBeUndefined();
  });

  test("marks only the final record part with a one-hour TTL", () => {
    const parts = [
      { text: "system", type: "text" },
      { text: "tail", type: "text" },
    ];

    expect(withPromptCacheControl(parts)).toEqual([
      { text: "system", type: "text" },
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "tail",
        type: "text",
      },
    ]);
  });

  test("leaves non-record final parts untouched", () => {
    expect(withPromptCacheControl(["plain"])).toEqual(["plain"]);
    expect(withPromptCacheControl([])).toEqual([]);
  });
});
