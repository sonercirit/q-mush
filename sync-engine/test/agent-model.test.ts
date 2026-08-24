import { describe, expect, test } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "../../shared/agent-prompt.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import {
  createChatCompletionsAgentModel,
  type ChatCompletionsAgentModel,
} from "../../sync-engine/agent-model.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  codexEventResponse,
  completeHello,
  DONE_CODEX_OUTPUT,
} from "./codex-response-fixtures.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";
import {
  cachedTextMessage,
  chatCompletionsDone,
} from "./prompt-cache-fixtures.ts";
type ModelOptions = Parameters<typeof createChatCompletionsAgentModel>[0];
const IMAGE_MESSAGE = {
  content: "Implement this design",
  images: [TEST_AGENT_IMAGE],
  role: "user" as const,
};
function apiKeyCredential(secret: string) {
  return { accountId: null, secret, source: "api_key" as const };
}
const OPENROUTER_IMAGE_OPTIONS = {
  credential: apiKeyCredential("sk-or-secret"),
  maxOutputTokens: null,
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
function capturedToolNames(body: unknown): readonly unknown[] {
  return isRecord(body) && Array.isArray(body["tools"])
    ? body["tools"].map((tool) =>
        isRecord(tool) && isRecord(tool["function"])
          ? tool["function"]["name"]
          : undefined,
      )
    : [];
}
function parallelToolUseSchema(
  body: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(body) || !Array.isArray(body["tools"])) {
    return {};
  }
  const tools: readonly unknown[] = body["tools"];
  const parallel = tools.find((tool) => {
    if (!isRecord(tool)) {
      return false;
    }
    const definition = isRecord(tool["function"]) ? tool["function"] : tool;
    return definition["name"] === "parallel";
  });
  if (!isRecord(parallel)) {
    return {};
  }
  const definition = isRecord(parallel["function"])
    ? parallel["function"]
    : parallel;
  const parameters = definition["parameters"];
  if (!isRecord(parameters) || !isRecord(parameters["properties"])) {
    return {};
  }
  const toolUses = parameters["properties"]["tool_uses"];
  return isRecord(toolUses) ? toolUses : {};
}
function expectUnboundedParallelSchema(body: unknown): void {
  const schema = parallelToolUseSchema(body);
  expect(schema).toMatchObject({ minItems: 2, type: "array" });
  expect(schema).not.toHaveProperty("maxItems");
  expect(() => JSON.stringify(body)).not.toThrow();
}
function capturedModel(
  capture: RequestCapture,
  options: Omit<ModelOptions, "fetch" | "toolSettings">,
): ChatCompletionsAgentModel {
  return respondingModel(options, chatCompletionsDone(), capture);
}
function openRouterModelWithTools(
  capture: RequestCapture,
  tools: readonly (typeof AGENT_SESSION_TOOL_NAMES)[number][],
): ChatCompletionsAgentModel {
  return capturedModel(capture, { ...OPENROUTER_IMAGE_OPTIONS, tools });
}
function genericModel(
  capture: RequestCapture,
  options: {
    readonly baseUrl: string;
    readonly model: string;
    readonly reasoningEffort?: "high";
    readonly secret: string;
  },
): ChatCompletionsAgentModel {
  return capturedModel(capture, {
    credential: {
      ...apiKeyCredential(options.secret),
      baseUrl: options.baseUrl,
    },
    maxOutputTokens: null,
    model: options.model,
    provider: "generic",
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: options.reasoningEffort }),
    tools: [],
  });
}
async function completeGenericModel(
  options: Parameters<typeof genericModel>[1],
): Promise<{ readonly body: unknown; readonly capture: RequestCapture }> {
  const capture = new RequestCapture();
  await completeHello(genericModel(capture, options));
  return { body: await capturedBody(capture), capture };
}
function respondingModel(
  options: Omit<ModelOptions, "fetch" | "toolSettings">,
  responseBody: unknown,
  capture: RequestCapture,
): ChatCompletionsAgentModel {
  return createChatCompletionsAgentModel({
    toolSettings: DEFAULT_TOOL_SETTINGS,
    ...options,
    fetch: captureRequest(capture, () => createJsonResponse(responseBody)),
  });
}
function codexModel(
  options: Omit<
    ModelOptions,
    "credential" | "maxOutputTokens" | "provider" | "toolSettings"
  >,
): ChatCompletionsAgentModel {
  return createChatCompletionsAgentModel({
    toolSettings: DEFAULT_TOOL_SETTINGS,
    ...options,
    credential: {
      accountId: "chatgpt-account",
      secret: createOpenAiOAuthSecret(),
      source: "oauth",
    },
    maxOutputTokens: null,
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
        ...OPENROUTER_IMAGE_OPTIONS,
        credential: { ...apiKeyCredential("sk-or-secret"), accountId: "a-1" },
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
    const step = await model.complete([
      { content: "Inspect the source", role: "user" },
    ]);
    expect(step).toEqual({
      content: "Inspecting.",
      contextTokens: 12_345,
      costUsd: null,
      thinking: "I should inspect the workspace first.",
      tokenUsage: null,
      toolCalls: [expectedTool],
    });
    expect(capture.request?.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(capture.request?.headers.get("authorization")).toBe(
      "Bearer sk-or-secret",
    );
    const body = await capturedBody(capture);
    expect(capturedToolNames(body)).toEqual(AGENT_SESSION_TOOL_NAMES);
    expect(body).toMatchObject({
      messages: [
        cachedTextMessage("system", "Workspace instructions from AGENTS.md"),
        cachedTextMessage("user", "Inspect the source"),
      ],
      model: "openai/gpt-4.1-mini",
      reasoning: { effort: "high", summary: "auto" },
      tool_choice: "auto",
    });
    expectUnboundedParallelSchema(body);
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).toContain('"edits"');
    expect(serializedBody).toContain('"tool_uses"');
    expect(serializedBody).toContain('"timeout"');
    expect(serializedBody).not.toContain("read_file");
    expect(serializedBody).not.toContain("list_files");
  });
  test("uses a generic OpenAI-compatible endpoint", async () => {
    const { body, capture } = await completeGenericModel({
      baseUrl: "https://models.example.test/openai/v1",
      model: "llama-3.3-70b",
      reasoningEffort: "high",
      secret: "generic-secret",
    });
    expect(capture.request?.url).toBe(
      "https://models.example.test/openai/v1/chat/completions",
    );
    expect(capture.request?.headers.get("authorization")).toBe(
      "Bearer generic-secret",
    );
    expect(isRecord(body) ? body["messages"] : undefined).toEqual([
      { content: AGENT_SYSTEM_PROMPT, role: "system" },
      { content: "Hello", role: "user" },
    ]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(body).toMatchObject({
      model: "llama-3.3-70b",
      reasoning_effort: "high",
      stream: true,
    });
  });
  test("omits authorization for a keyless generic endpoint", async () => {
    const completed = await completeGenericModel({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3",
      secret: "",
    });
    expect(completed.capture.request?.headers.has("authorization")).toBe(false);
  });
  async function expectOpenRouterProvider(
    capture: RequestCapture,
    model: ReturnType<typeof capturedModel>,
    provider: unknown,
  ): Promise<void> {
    await completeHello(model);
    expect(await capturedBody(capture)).toMatchObject({ provider });
  }
  function routedModel(
    capture: RequestCapture,
    openRouterProviderRouting: NonNullable<
      Parameters<typeof capturedModel>[1]["openRouterProviderRouting"]
    >,
  ) {
    return capturedModel(capture, {
      ...OPENROUTER_IMAGE_OPTIONS,
      openRouterProviderRouting,
    });
  }
  test("maps OpenRouter routing to provider preferences", async () => {
    const selections = [
      [{ sort: "price", type: "sort" }, { sort: "price" }],
      [{ sort: "throughput", type: "sort" }, { sort: "throughput" }],
      [{ sort: "latency", type: "sort" }, { sort: "latency" }],
      [{ sort: "exacto", type: "sort" }, { sort: "exacto" }],
      [{ type: "no_fallbacks" }, { allow_fallbacks: false }],
      [
        { tag: "google-vertex/us", type: "order" },
        { order: ["google-vertex/us"] },
      ],
    ] as const;
    for (const [openRouterProviderRouting, provider] of selections) {
      const capture = new RequestCapture();
      const model = routedModel(capture, openRouterProviderRouting);
      await expectOpenRouterProvider(capture, model, provider);
    }
  });
  test("uses only the ordered selected OpenRouter serving provider", async () => {
    const capture = new RequestCapture();
    const model = routedModel(capture, {
      tag: "google-vertex/us",
      type: "provider",
    });
    await expectOpenRouterProvider(capture, model, {
      allow_fallbacks: false,
      order: ["google-vertex/us"],
    });
  });
  test("sends the unbounded schema through OpenAI Responses", async () => {
    const capture = new RequestCapture();
    const output = [DONE_CODEX_OUTPUT];
    const model = capturedCodexModel(capture, codexEventResponse(output));
    await completeHello(model);
    expectUnboundedParallelSchema(await capturedBody(capture));
  });
  test("filters definitions to the selected tools and skills", async () => {
    const capture = new RequestCapture();
    const selectedTools = ["read", "brave_search"] as const;
    const model = openRouterModelWithTools(capture, selectedTools);
    await completeHello(model);
    expect(capturedToolNames(await capturedBody(capture))).toEqual(
      selectedTools,
    );
  });
  test("omits the tool protocol when none are selected", async () => {
    const capture = new RequestCapture();
    const model = openRouterModelWithTools(capture, []);
    await completeHello(model);
    const body = await capturedBody(capture);
    expect(body).not.toMatchObject({ tool_choice: "auto" });
    expect(capturedToolNames(body)).toEqual([]);
  });
  test("sends images through chat completions", async () => {
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
        credential: apiKeyCredential("sk-openai-secret"),
        maxOutputTokens: null,
        model: "gpt-5-codex",
        provider: "openai",
        reasoningEffort: "low",
      },
      chatCompletionsDone(),
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
      costUsd: null,
      thinking: "I checked the prior tool result.",
      tokenUsage: null,
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
  test("shows the provider's error message", async () => {
    const model = createChatCompletionsAgentModel({
      credential: apiKeyCredential("secret"),
      toolSettings: DEFAULT_TOOL_SETTINGS,
      maxOutputTokens: null,
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
