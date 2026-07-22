import { describe, expect, test } from "vitest";
import {
  AGENT_COMPACTION_SYSTEM_PROMPT,
  ModelConversationCompactor,
  shouldCompactContext,
} from "../../sync-engine/agent-compaction.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

describe("agent conversation compaction", () => {
  test("uses a 95% threshold only when the context limit is known", () => {
    expect(shouldCompactContext(94_999, 100_000)).toBe(false);
    expect(shouldCompactContext(95_000, 100_000)).toBe(true);
    expect(shouldCompactContext(100_000, null)).toBe(false);
  });

  test("replaces a complete conversation with a handoff summary", async () => {
    const model = new ScriptedAgentModel([
      { content: " Keep the current changes and run tests. ", toolCalls: [] },
    ]);
    const compactor = new ModelConversationCompactor(model);
    const compacted = await compactor.compact([
      { content: "Make the change", role: "user" },
    ]);

    expect(compacted.summary).toBe("Keep the current changes and run tests.");
    expect(compacted.messages).toEqual([
      {
        content:
          "The earlier conversation was compacted into this handoff summary. Treat it as prior context and continue from it:\n\nKeep the current changes and run tests.",
        role: "user",
      },
    ]);
    expect(model.requests[0]?.at(-1)).toEqual({
      content:
        "Compact this conversation now. Return only the handoff summary.",
      role: "user",
    });
    expect(AGENT_COMPACTION_SYSTEM_PROMPT).toContain("Do not call tools");
  });
});
