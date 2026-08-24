import { describe, expect, test } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import {
  createModelConversationCompactor,
  shouldCompactContext,
} from "../../sync-engine/agent-compaction.ts";
import { completionMessages } from "../../sync-engine/agent-completion.ts";
import {
  TEST_COMPACTION_HANDOFF_INSTRUCTION,
  TEST_COMPACTION_REQUEST_MESSAGE,
} from "./compaction-test-fixtures.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";

const PARTIAL_ANSWER = {
  content: "Partial answer",
  role: "assistant" as const,
  toolCalls: [],
};

function truncationNotice(): Extract<
  AgentConversationMessage,
  { readonly role: "compaction_notice" }
> {
  return {
    content: "",
    role: "compaction_notice",
    truncation: "max_tokens",
  };
}

describe("agent conversation compaction", () => {
  test("uses a 95% threshold only when the context limit is known", () => {
    expect(shouldCompactContext(94_999, 100_000)).toBe(false);
    expect(shouldCompactContext(95_000, 100_000)).toBe(true);
    expect(shouldCompactContext(100_000, null)).toBe(false);
  });

  test("appends the handoff request without changing the conversation prefix", async () => {
    const model = createScriptedAgentModel([
      {
        content: " Keep the current changes and run tests. ",
        contextTokens: 12_345,
        toolCalls: [],
      },
    ]);
    const compactor = createModelConversationCompactor(model);
    const conversation = [
      { content: "Make the change", role: "user" as const },
      {
        content: "The change is ready.",
        role: "assistant" as const,
        toolCalls: [],
      },
    ];
    const compacted = await compactor.compact(conversation);

    // Compaction is a model step: the step timer must restart at its
    // request, not keep timing the preceding agent step.
    expect(model.stepStarts).toBe(1);
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

  test("sends a truncation marker only to the compactor", async () => {
    const model = createScriptedAgentModel([
      { content: "The prior answer was truncated.", toolCalls: [] },
    ]);
    const compactor = createModelConversationCompactor(model);

    await compactor.compact([PARTIAL_ANSWER, truncationNotice()]);

    expect(model.requests[0]).toEqual([
      PARTIAL_ANSWER,
      {
        content:
          "The preceding assistant response reached the maximum output tokens and is partial. Preserve that fact explicitly in the summary; do not describe the response as a finished answer or deliverable.",
        role: "user",
      },
      { content: TEST_COMPACTION_REQUEST_MESSAGE, role: "user" },
    ]);
    expect(model.requests[0]).not.toContainEqual(truncationNotice());
    expect(completionMessages([[PARTIAL_ANSWER, truncationNotice()]])).toEqual([
      PARTIAL_ANSWER,
    ]);
  });

  test.each(["max_tokens", "model_context_window_exceeded"] as const)(
    "rejects a summary truncated by a %s stop",
    async (truncation) => {
      // A truncated summary replaces the whole conversation if accepted;
      // compaction must fail instead of persisting an incomplete handoff.
      const compactor = createModelConversationCompactor({
        complete: () =>
          Promise.resolve(providerStep("Cut-short summary", { truncation })),
      });

      await expect(
        compactor.compact([{ content: "Work", role: "user" }]),
      ).rejects.toThrow("invalid compaction summary");
    },
  );
});
