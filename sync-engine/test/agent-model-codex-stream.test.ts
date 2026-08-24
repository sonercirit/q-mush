import { describe, expect, test } from "vitest";
import { createChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import {
  codexEventResponse,
  codexModelOptions,
  completeHello,
  DONE_CODEX_OUTPUT,
} from "./codex-response-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

describe("chat completions agent model", () => {
  test("uses streamed Codex output when the completed response omits it", async () => {
    const model = createChatCompletionsAgentModel(
      codexModelOptions({
        fetch: () =>
          Promise.resolve(
            new Response(
              [
                'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"I considered"}',
                'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":" the request."}',
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}',
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there."}',
                'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"function-1","call_id":"call-1","name":"read","arguments":""}}',
                'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"path\\":"}',
                'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"src/index.ts\\"}"}',
                'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}',
                "data: [DONE]",
                "",
              ].join("\n\n"),
            ),
          ),
        model: "codex-test-model",
        reasoningEffort: "max",
      }),
    );

    expect(await completeHello(model)).toEqual({
      content: "Hello there.",
      contextTokens: null,
      costUsd: null,
      thinking: "I considered the request.",
      tokenUsage: null,
      toolCalls: [
        {
          arguments: '{"path":"src/index.ts"}',
          id: "call-1",
          name: "read",
        },
      ],
    });
  });

  test("accepts Codex event streams without a local response-size limit", async () => {
    const padding = `:${"x".repeat(10 * 1_024 * 1_024)}\n\n`;
    const model = createChatCompletionsAgentModel(
      codexModelOptions({
        fetch: () =>
          Promise.resolve(codexEventResponse([DONE_CODEX_OUTPUT], padding)),
        model: "gpt-5-codex",
      }),
    );

    expectDoneStep(await completeHello(model));
  });
});
