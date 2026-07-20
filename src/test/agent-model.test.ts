import { describe, expect, test } from "bun:test";
import { ChatCompletionsAgentModel } from "../agent-model.ts";
import { isRecord } from "../auth-model.ts";
import { createJsonResponse } from "../http.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";

type ModelOptions = ConstructorParameters<typeof ChatCompletionsAgentModel>[0];

class RequestCapture {
  request?: Request;
}

async function capturedBody(capture: RequestCapture): Promise<unknown> {
  return capture.request?.json();
}

function respondingModel(
  options: Omit<ModelOptions, "fetch">,
  responseBody: unknown,
  capture: RequestCapture,
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    ...options,
    fetch: (request) => {
      capture.request = request;
      return Promise.resolve(createJsonResponse(responseBody));
    },
  });
}

describe("chat completions agent model", () => {
  test("sends the native tool protocol to OpenRouter and reads tool calls", async () => {
    const capture = new RequestCapture();
    const expectedTool = {
      arguments: '{"path":"src"}',
      id: "tool-1",
      name: "list_files",
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
      },
      {
        choices: [
          {
            message: {
              content: "Inspecting.",
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
      },
      capture,
    );

    const turn = await model.complete([
      { content: "Inspect the source", role: "user" },
    ]);

    expect(turn).toEqual({ content: "Inspecting.", toolCalls: [expectedTool] });
    expect(capture.request?.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(capture.request?.headers.get("authorization")).toBe(
      "Bearer sk-or-secret",
    );
    const body = await capturedBody(capture);
    expect(body).toMatchObject({
      messages: [
        { role: "system" },
        { content: "Inspect the source", role: "user" },
      ],
      model: "openai/gpt-4.1-mini",
      reasoning: { effort: "high" },
      tool_choice: "auto",
    });
    expect(JSON.stringify(body)).toContain("read_file");
    expect(JSON.stringify(body)).toContain("run_command");
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
    const oauthSecret = createOpenAiOAuthSecret();
    const model = new ChatCompletionsAgentModel({
      credential: {
        accountId: "chatgpt-account",
        secret: oauthSecret,
        source: "oauth",
      },
      fetch: (request) => {
        capture.request = request;
        const completed = {
          response: {
            output: [
              {
                content: [{ text: "Done.", type: "output_text" }],
                type: "message",
              },
            ],
          },
          type: "response.completed",
        };
        return Promise.resolve(
          new Response(
            `data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
          ),
        );
      },
      model: "gpt-5-codex",
      provider: "openai",
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
            name: "read_file",
          },
        ],
      },
      {
        content: "# Project",
        role: "tool" as const,
        toolCallId: "previous-call",
        toolName: "read_file",
      },
    ];
    expect(await model.complete(conversation)).toEqual({
      content: "Done.",
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
      reasoning: { effort: "medium" },
      store: false,
      stream: true,
    });
    expect(
      isRecord(body) && typeof body["instructions"] === "string",
    ).toBeTrue();
    expect(JSON.stringify(body)).toContain("function_call_output");
    expect(JSON.stringify(body)).toContain("previous-call");
  });

  test("uses streamed Codex text when the completed response omits output", async () => {
    const model = new ChatCompletionsAgentModel({
      credential: {
        accountId: "chatgpt-account",
        secret: createOpenAiOAuthSecret(),
        source: "oauth",
      },
      fetch: () =>
        Promise.resolve(
          new Response(
            [
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}',
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there."}',
              'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
          ),
        ),
      model: "gpt-5.6-sol",
      provider: "openai",
      reasoningEffort: "max",
    });

    expect(await model.complete([{ content: "Hello", role: "user" }])).toEqual({
      content: "Hello there.",
      toolCalls: [],
    });
  });

  test("does not expose provider response bodies in errors", async () => {
    const model = new ChatCompletionsAgentModel({
      credential: { accountId: null, secret: "secret", source: "api_key" },
      fetch: () =>
        Promise.resolve(
          new Response("sensitive provider detail", { status: 429 }),
        ),
      model: "gpt-4.1-mini",
      provider: "openai",
    });
    const error = await captureRejection(
      model.complete([{ content: "Hello", role: "user" }]),
    );

    const message = requireError(error).message;
    expect(message).toContain("OpenAI request failed with status 429");
    expect(message).not.toContain("sensitive provider detail");
  });
});
