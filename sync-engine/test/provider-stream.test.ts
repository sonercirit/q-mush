import { expect, test } from "vitest";
import { createProviderStreamAccumulator } from "../../sync-engine/provider-stream.ts";

const TOOL_CALL = {
  function: { arguments: "", name: "read" },
  id: "tool-1",
  type: "function",
};

test("accumulates OpenAI-compatible chat completion chunks", () => {
  const accumulator = createProviderStreamAccumulator("chat_completions");

  accumulator.push({
    choices: [
      {
        delta: {
          content: "Inspecting ",
          reasoning: "Need to ",
          tool_calls: [{ ...TOOL_CALL, index: 0 }],
        },
      },
    ],
  });
  accumulator.push({
    choices: [
      {
        delta: {
          content: "now.",
          reasoning: "read.",
          tool_calls: [
            {
              function: { arguments: '{"path":"README.md"}' },
              index: 0,
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 123 },
  });

  expect(accumulator.finish()).toEqual({
    content: "Inspecting now.",
    contextTokens: 123,
    costUsd: null,
    thinking: "Need to read.",
    tokenUsage: null,
    toolCalls: [
      {
        arguments: '{"path":"README.md"}',
        id: "tool-1",
        name: "read",
      },
    ],
  });
});

test("accumulates provider-reported cost and detailed token usage", () => {
  const accumulator = createProviderStreamAccumulator(
    "chat_completions",
    () => undefined,
  );

  accumulator.push({
    choices: [],
    usage: {
      output_tokens: 13,
      cost: "0.0042",
      prompt_tokens: 123,
      prompt_tokens_details: { cached_tokens: 100 },
    },
  });

  expect(accumulator.finish()).toMatchObject({
    contextTokens: 123,
    costUsd: 0.0042,
    tokenUsage: {
      cacheWriteInputTokens: 0,
      cachedInputTokens: 100,
      inputTokens: 123,
      outputTokens: 13,
    },
  });
});

test("retains non-streaming chat-completion reasoning details", () => {
  const accumulator = createProviderStreamAccumulator("chat_completions_json");
  accumulator.push({
    choices: [
      {
        message: {
          content: "Done.",
          reasoning_details: [
            { summary: "First thought", type: "reasoning.summary" },
            { text: "Second thought", type: "reasoning.text" },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 9 },
  });

  expect(accumulator.finish()).toEqual({
    content: "Done.",
    contextTokens: 9,
    costUsd: null,
    thinking: "First thought\n\nSecond thought",
    tokenUsage: null,
    toolCalls: [],
  });
});

test("separates streamed Responses reasoning summaries with newlines", () => {
  const deltas: string[] = [];
  const recordThinking = (delta: { readonly thinking: string }): void => {
    deltas.push(delta.thinking);
  };
  const accumulator = createProviderStreamAccumulator(
    "responses",
    recordThinking,
  );

  for (const event of [
    {
      delta: "Summarizing final test results and output features",
      output_index: 0,
      summary_index: 0,
      type: "response.reasoning_summary_text.delta",
    },
    {
      delta: "Reviewing shell output parsing logic",
      output_index: 0,
      summary_index: 1,
      type: "response.reasoning_summary_text.delta",
    },
    {
      delta: "Confirming unique call ID handling",
      output_index: 1,
      summary_index: 0,
      type: "response.reasoning_summary_text.delta",
    },
  ]) {
    accumulator.push(event);
  }
  accumulator.push({
    response: { output: [] },
    type: "response.completed",
  });

  expect(deltas).toEqual([
    "Summarizing final test results and output features",
    "\n\nReviewing shell output parsing logic",
    "\n\nConfirming unique call ID handling",
  ]);
  expect(accumulator.finish().thinking).toBe(
    [
      "Summarizing final test results and output features",
      "Reviewing shell output parsing logic",
      "Confirming unique call ID handling",
    ].join("\n\n"),
  );
});

test("surfaces provider stream error details", () => {
  const accumulator = createProviderStreamAccumulator("responses");

  expect(() => {
    accumulator.push({
      error: { message: "The model is unavailable." },
      type: "error",
    });
  }).toThrow(
    "The provider failed to complete the request: The model is unavailable.",
  );
});

test("emits every provider text delta before completion", () => {
  const deltas: string[] = [];
  const accumulator = createProviderStreamAccumulator("responses", (delta) => {
    deltas.push(delta.content);
  });

  accumulator.push({ type: "response.output_text.delta", delta: "Hello" });
  accumulator.push({ type: "response.output_text.delta", delta: " world" });
  accumulator.push({
    type: "response.completed",
    response: { output: [], usage: { input_tokens: 45 } },
  });

  expect(deltas).toEqual(["Hello", " world"]);
  expect(accumulator.finish()).toEqual({
    content: "Hello world",
    contextTokens: 45,
    costUsd: null,
    thinking: "",
    tokenUsage: null,
    toolCalls: [],
  });
});
