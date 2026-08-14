import { describe, expect, test } from "vitest";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  compacted,
  recordingCompactor,
  runTestLoop,
  TOOL_CALL,
} from "./session-agent-loop-test-helpers.ts";

const TRUNCATED_ANSWER = "Partial answer cut off at the output limit.";

function isTruncationNotice(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    "role" in value &&
    value.role === "compaction_notice" &&
    "truncation" in value &&
    value.truncation === "max_tokens"
  );
}

function truncationNotice(conversation: unknown): unknown {
  if (!Array.isArray(conversation)) return undefined;
  return conversation.find(isTruncationNotice);
}

function assistantMessageContent(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value &&
    typeof value.content === "string"
    ? value.content
    : undefined;
}

function assistantContent(conversation: unknown): readonly string[] {
  if (!Array.isArray(conversation)) return [];
  const content: string[] = [];
  for (const message of conversation) {
    const value: unknown = message;
    const assistant = assistantMessageContent(value);
    if (assistant !== undefined) content.push(assistant);
  }
  return content;
}

function expectSingleCompaction(
  compactedConversations: readonly unknown[],
): unknown {
  expect(compactedConversations).toHaveLength(1);
  return compactedConversations[0];
}

function expectTruncationMarked(
  compactedConversations: readonly unknown[],
): void {
  const conversation = expectSingleCompaction(compactedConversations);
  expect(assistantContent(conversation)).toContain(TRUNCATED_ANSWER);
  expect(truncationNotice(conversation)).toBeDefined();
}

describe("truncated answer compaction", () => {
  test.each([
    {
      contextTokens: 95_000,
      maxContextTokens: 100_000,
      mode: "automatic",
    },
    { contextTokens: 94_999, maxContextTokens: null, mode: "manual" },
  ])(
    "marks a terminal max_tokens answer for $mode compaction",
    async ({ contextTokens, maxContextTokens, mode }) => {
      const compactedConversations: unknown[] = [];
      let boundary = 0;

      await runTestLoop({
        createCompactor: recordingCompactor(compactedConversations, () =>
          compacted("The answer was partial and must be continued."),
        ),
        maxContextTokens,
        model: new ScriptedAgentModel([
          {
            content: TRUNCATED_ANSWER,
            contextTokens,
            toolCalls: [],
            truncation: "max_tokens",
          },
          { content: `Continued after ${mode} compaction.`, toolCalls: [] },
        ]),
        ...(mode === "manual"
          ? {
              onStepBoundary: () => {
                boundary += 1;
                return boundary === 2 ? ("compact" as const) : undefined;
              },
            }
          : {}),
      });

      expectTruncationMarked(compactedConversations);
    },
  );

  test("clears an earlier truncation before compacting a successful retry", async () => {
    const compactedConversations: unknown[] = [];
    let boundary = 0;

    const compactor = recordingCompactor(compactedConversations, () =>
      compacted("The retry finished successfully."),
    );
    await runTestLoop({
      createCompactor: compactor,
      maxContextTokens: null,
      model: new ScriptedAgentModel([
        {
          content: "A partial tool step.",
          toolCalls: [TOOL_CALL],
          truncation: "max_tokens",
        },
        { content: "The complete retried answer.", toolCalls: [] },
        { content: "Continued after compaction.", toolCalls: [] },
      ]),
      onStepBoundary: () => {
        boundary += 1;
        return boundary === 4 ? "compact" : undefined;
      },
    });

    const conversation = expectSingleCompaction(compactedConversations);
    expect(assistantContent(conversation)).toContain(
      "The complete retried answer.",
    );
    expect(truncationNotice(conversation)).toBeUndefined();
  });
});
