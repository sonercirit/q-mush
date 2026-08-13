import { describe, expect, test } from "vitest";
import {
  ModelConversationCompactor,
  shouldCompactContext,
} from "../../sync-engine/agent-compaction.ts";
import {
  TEST_COMPACTION_HANDOFF_INSTRUCTION,
  TEST_COMPACTION_REQUEST_MESSAGE,
} from "./compaction-test-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

describe("agent conversation compaction", () => {
  test("uses a 95% threshold only when the context limit is known", () => {
    expect(shouldCompactContext(94_999, 100_000)).toBe(false);
    expect(shouldCompactContext(95_000, 100_000)).toBe(true);
    expect(shouldCompactContext(100_000, null)).toBe(false);
  });

  test("appends the handoff request without changing the conversation prefix", async () => {
    const model = new ScriptedAgentModel([
      {
        content: " Keep the current changes and run tests. ",
        contextTokens: 12_345,
        toolCalls: [],
      },
    ]);
    const compactor = new ModelConversationCompactor(model);
    const conversation = [
      { content: "Make the change", role: "user" as const },
      {
        content: "The change is ready.",
        role: "assistant" as const,
        toolCalls: [],
      },
    ];
    const compacted = await compactor.compact(conversation);

    expect(compacted.summary).toBe("Keep the current changes and run tests.");
    expect(compacted).toMatchObject({
      contextTokens: 12_345,
      costUsd: null,
      tokenUsage: null,
    });
    expect(compacted.messages).toEqual([
      {
        content: `The earlier conversation was compacted. ${TEST_COMPACTION_HANDOFF_INSTRUCTION}\n\nKeep the current changes and run tests.`,
        role: "user",
      },
    ]);
    expect(model.requests[0]?.slice(0, -1)).toEqual(conversation);
    expect(model.requests[0]?.at(-1)?.content).toBe(
      TEST_COMPACTION_REQUEST_MESSAGE,
    );
    expect(model.requests[0]?.at(-1)?.role).toBe("user");
  });
});
