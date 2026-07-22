import { describe, expect, test } from "vitest";
import type { AgentModelTurn } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";
import { expectDoneTurn } from "./provider-turn-fixtures.ts";

type ModelOptions = ConstructorParameters<typeof ChatCompletionsAgentModel>[0];

const DONE_CODEX_OUTPUT = {
  content: [{ text: "Done.", type: "output_text" }],
  type: "message",
};
const IMAGE_MESSAGE = {
  content: "Implement this design",
  images: [TEST_AGENT_IMAGE],
  role: "user" as const,
};
const OPENROUTER_IMAGE_OPTIONS = {
  credential: {
    accountId: null,
    secret: "sk-or-secret",
    source: "api_key" as const,
  },
  model: "openai/gpt-4.1-mini",
  provider: "openrouter" as const,
};

class RequestCapture {
  request?: Request;
}

async function capturedBody(capture: RequestCapture): Promise<unknown> {
  return capture.request?.json();
}

function captureRequest(
  capture: RequestCapture,
  response: () => Response,
): (request: Request) => Promise<Response> {
  return (request) => {
    capture.request = request;
    return Promise.resolve(response());
  };
}

function respondingModel(
  options: Omit<ModelOptions, "fetch">,
  responseBody: unknown,
  capture: RequestCapture,
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    ...options,
    fetch: captureRequest(capture, () => createJsonResponse(responseBody)),
  });
}

function codexModel(
  options: Omit<ModelOptions, "credential" | "provider">,
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    ...options,
    credential: {
      accountId: "chatgpt-account",
      secret: createOpenAiOAuthSecret(),
      source: "oauth",
    },
    provider: "openai",
  });
}

function capturedCodexModel(
  capture: RequestCapture,
  response: Response,
  model = "gpt-5-codex",
): ChatCompletionsAgentModel {
  return codexModel({ fetch: captureRequest(capture, () => response), model });
}

function codexEventResponse(
  output: readonly unknown[],
  prefix = "",
  usage?: Readonly<Record<string, number>>,
): Response {
  const completed = {
    response: { output, ...(usage === undefined ? {} : { usage }) },
    type: "response.completed",
  };
  return new Response(
    `${prefix}data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
  );
}

function completeHello(
  model: ChatCompletionsAgentModel,
): Promise<AgentModelTurn> {
  return model.complete([{ content: "Hello", role: "user" }]);
}

describe("chat completions agent model", () => {
  test("sends the native tool protocol to OpenRouter and reads tool calls", async () => {
    const capture = new RequestCapture();
    const expectedTool = {
      arguments: '{"path":"src/index.ts"}',
      id: "tool-1",
      name: "read",
    };
    const model = respondingModel(
      {
        credential: {
          accountId: "account-1",
          secret: "sk-or-secret",
          source: "api_key",
        },
        model: "openai/gpt-4.1-mini",
        provider: "openrouter",
        reasoningEffort: "high",
        systemPrompt: "Workspace instructions from AGENTS.md",
      },
      {
        choices: [
          {
            message: {
              content: "Inspecting.",
              reasoning: "I should inspect the workspace first.",
              tool_calls: [
                {
                  function: {
                    arguments: expectedTool.arguments,
                    name: expectedTool.name,
                  },
                  id: expectedTool.id,
                  type: "function",
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12_345 },
      },
      capture,
    );

    const turn = await model.complete([
      { content: "Inspect the source", role: "user" },
    ]);

    expect(turn).toEqual({
      content: "Inspecting.",
      contextTokens: 12_345,
      thinking: "I should inspect the workspace first.",
      toolCalls: [expectedTool],
    });
    expect(capture.request?.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(capture.request?.headers.get("authorization")).toBe(
      "Bearer sk-or-secret",
    );
    const body = await capturedBody(capture);
    expect(body).toMatchObject({
      messages: [
        {
          content: "Workspace instructions from AGENTS.md",
          role: "system",
        },
        { content: "Inspect the source", role: "user" },
      ],
      model: "openai/gpt-4.1-mini",
      reasoning: { effort: "high", summary: "auto" },
      tool_choice: "auto",
    });
    const serializedBody = JSON.stringify(body);
    const toolNames =
      isRecord(body) && Array.isArray(body["tools"])
        ? body["tools"].map((tool) =>
            isRecord(tool) && isRecord(tool["function"])
              ? tool["function"]["name"]
              : undefined,
          )
        : [];
    expect(toolNames).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "parallel",
      "brave_search",
    ]);
    expect(serializedBody).toContain('"edits"');
    expect(serializedBody).toContain('"tool_uses"');
    expect(serializedBody).toContain('"timeout"');
    expect(serializedBody).not.toContain("read_file");
    expect(serializedBody).not.toContain("list_files");
  });

  test("sends image inputs through chat completions", async () => {
    const capture = new RequestCapture();
    const model = respondingModel(
      OPENROUTER_IMAGE_OPTIONS,
      { choices: [{ message: { content: "I see the image." } }] },
      capture,
    );

    await model.complete([
      { ...IMAGE_MESSAGE, content: "What is in this screenshot?" },
    ]);

    expect(await capturedBody(capture)).toMatchObject({
      messages: [
        { role: "system" },
        {
          content: [
            { text: "What is in this screenshot?", type: "text" },
            {
              image_url: {
                url: `data:image/png;base64,${TEST_AGENT_IMAGE.data}`,
              },
              type: "image_url",
            },
          ],
          role: "user",
        },
      ],
    });
  });

  test("sends image inputs through the Responses protocol", async () => {
    const capture = new RequestCapture();
    const model = capturedCodexModel(
      capture,
      codexEventResponse([DONE_CODEX_OUTPUT]),
    );

    await model.complete([IMAGE_MESSAGE]);

    expect(await capturedBody(capture)).toMatchObject({
      input: [
        {
          content: [
            { text: "Implement this design", type: "input_text" },
            {
              image_url: `data:image/png;base64,${TEST_AGENT_IMAGE.data}`,
              type: "input_image",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
    });
  });

  test("uses the OpenAI chat-completions reasoning parameter", async () => {
    const capture = new RequestCapture();
    const model = respondingModel(
      {
        credential: {
          accountId: null,
          secret: "sk-openai-secret",
          source: "api_key",
        },
        model: "gpt-5-codex",
        provider: "openai",
        reasoningEffort: "low",
      },
      { choices: [{ message: { content: "Done." } }] },
      capture,
    );

    await model.complete([{ content: "Fix the bug", role: "user" }]);

    expect(await capturedBody(capture)).toMatchObject({
      model: "gpt-5-codex",
      reasoning_effort: "low",
    });
  });

  test("uses the Codex Responses protocol for an OpenAI OAuth credential", async () => {
    const capture = new RequestCapture();
    const response = codexEventResponse(
      [
        {
          summary: [
            {
              text: "I checked the prior tool result.",
              type: "summary_text",
            },
          ],
          type: "reasoning",
        },
        DONE_CODEX_OUTPUT,
      ],
      "",
      { input_tokens: 23_456 },
    );
    const model = codexModel({
      fetch: captureRequest(capture, () => response),
      model: "gpt-5-codex",
      reasoningEffort: "medium",
    });

    const conversation = [
      { content: "Hello", role: "user" as const },
      {
        content: "Checking.",
        role: "assistant" as const,
        toolCalls: [
          {
            arguments: '{"path":"README.md"}',
            id: "previous-call",
            name: "read",
          },
        ],
      },
      {
        content: "# Project",
        role: "tool" as const,
        toolCallId: "previous-call",
        toolName: "read",
      },
    ];
    expect(await model.complete(conversation)).toEqual({
      content: "Done.",
      contextTokens: 23_456,
      thinking: "I checked the prior tool result.",
      toolCalls: [],
    });
    expect(capture.request?.url).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(capture.request?.headers.get("authorization")).toBe(
      "Bearer oauth-access-token",
    );
    expect(capture.request?.headers.get("chatgpt-account-id")).toBe(
      "chatgpt-account",
    );
    expect(capture.request?.headers.get("accept")).toBe("text/event-stream");
    const body = await capturedBody(capture);
    expect(body).toMatchObject({
      model: "gpt-5-codex",
      reasoning: { effort: "medium", summary: "auto" },
      store: false,
      stream: true,
    });
    expect(isRecord(body) && typeof body["instructions"] === "string").toBe(
      true,
    );
    expect(JSON.stringify(body)).toContain("function_call_output");
    expect(JSON.stringify(body)).toContain("previous-call");
  });

  test("uses streamed Codex output when the completed response omits it", async () => {
    const model = codexModel({
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
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    });

    expect(await completeHello(model)).toEqual({
      content: "Hello there.",
      contextTokens: null,
      thinking: "I considered the request.",
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
    const model = codexModel({
      fetch: () =>
        Promise.resolve(codexEventResponse([DONE_CODEX_OUTPUT], padding)),
      model: "gpt-5-codex",
    });

    expectDoneTurn(await completeHello(model));
  });

  test("shows the provider's error message", async () => {
    const model = new ChatCompletionsAgentModel({
      credential: { accountId: null, secret: "secret", source: "api_key" },
      fetch: () =>
        Promise.resolve(
          createJsonResponse(
            {
              error: {
                code: "unsupported_parameter",
                message: "The selected model does not support tools.",
                type: "invalid_request_error",
              },
            },
            400,
          ),
        ),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
    const error = await captureRejection(
      model.complete([{ content: "Hello", role: "user" }]),
    );

    expect(requireError(error).message).toBe(
      "OpenAI request failed with status 400: The selected model does not support tools.",
    );
  });
});
