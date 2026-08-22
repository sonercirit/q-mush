import { describe, expect, test } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "../../shared/agent-prompt.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import {
  agentProviderRequestHeaders,
  ChatCompletionsAgentModel,
} from "../../sync-engine/agent-model.ts";
import {
  cachedText,
  cachedTextMessage,
  TEST_PROMPT_CACHE_CONTROL,
} from "./prompt-cache-fixtures.ts";
import { providerStep } from "./provider-step-fixtures.ts";

type ModelOptions = ConstructorParameters<typeof ChatCompletionsAgentModel>[0];

const BASE_URL = "https://anthropic.example.test/v1";
const KNOWN_MODEL = "claude-test-4";
const ANTHROPIC_CREDENTIAL = {
  accountId: null,
  apiFormat: "anthropic",
  baseUrl: BASE_URL,
  secret: "anthropic-secret",
  source: "api_key",
} as const;

function anthropicEvents(events: readonly unknown[]): Response {
  const body = events
    .map((event) =>
      isRecord(event)
        ? `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`
        : "",
    )
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function textStopEvents(options: {
  readonly stopReason: string;
  readonly text: string;
  readonly usage: Readonly<Record<string, number>>;
}): Response {
  return anthropicEvents([
    { message: { usage: options.usage }, type: "message_start" },
    {
      content_block: { text: "", type: "text" },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { text: options.text, type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    },
    { index: 0, type: "content_block_stop" },
    {
      delta: { stop_reason: options.stopReason },
      type: "message_delta",
      usage: { output_tokens: options.text.length },
    },
    { type: "message_stop" },
  ]);
}

function doneEvents(): Response {
  return textStopEvents({
    stopReason: "end_turn",
    text: "Done.",
    usage: {
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 900,
      input_tokens: 60,
    },
  });
}

function expectAbsentProperties(
  body: unknown,
  properties: readonly string[],
): void {
  for (const property of properties) {
    expect(body).not.toHaveProperty(property);
  }
}

async function effortRequestBody(
  effort: "minimal" | "none" | "xhigh",
  adaptiveThinking: boolean | null = true,
): Promise<unknown> {
  const harness = anthropicHarness([doneEvents()], {
    adaptiveThinking,
    reasoningEffort: effort,
  });
  await harness.complete();
  return harness.requestBody(0);
}

function invalidRequestResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error" },
      type: "error",
    }),
    { status: 400 },
  );
}

interface AnthropicHarness {
  readonly complete: (
    messages?: Parameters<ChatCompletionsAgentModel["complete"]>[0],
  ) => ReturnType<ChatCompletionsAgentModel["complete"]>;
  readonly requestBody: (index: number) => Promise<unknown>;
  readonly requests: Request[];
}

function anthropicHarness(
  responses: readonly Response[],
  options: Partial<ModelOptions> = {},
): AnthropicHarness {
  const requests: Request[] = [];
  const remaining = [...responses];
  const model = new ChatCompletionsAgentModel({
    toolSettings: DEFAULT_TOOL_SETTINGS,
    credential: ANTHROPIC_CREDENTIAL,
    fetch: (request) => {
      requests.push(request);
      const response = remaining.shift();
      if (response === undefined) {
        throw new Error("No scripted response remains");
      }
      return Promise.resolve(response);
    },
    maxOutputTokens: null,
    model: KNOWN_MODEL,
    provider: "generic",
    ...options,
  });
  return {
    complete: (messages = [{ content: "Hello", role: "user" }]) =>
      model.complete(messages),
    requestBody: async (index) => {
      const body: unknown = await requests[index]?.json();
      return body;
    },
    requests,
  };
}

async function recordRequestBody(
  harness: AnthropicHarness,
  index: number,
): Promise<Readonly<Record<string, unknown>>> {
  const body = await harness.requestBody(index);
  if (!isRecord(body)) {
    throw new Error("The captured body was not a record");
  }
  return body;
}

describe("anthropic-format generic provider", () => {
  test("sends the catalog max output tokens when the session carries them", async () => {
    const harness = anthropicHarness([doneEvents()], {
      maxOutputTokens: 64_000,
    });
    await harness.complete();

    const body = await recordRequestBody(harness, 0);
    expect(body["max_tokens"]).toBe(64_000);
  });

  test("identifies a non-streaming Messages completion by protocol", () => {
    const headers = agentProviderRequestHeaders(
      "generic",
      {
        ...ANTHROPIC_CREDENTIAL,
        baseUrl: "https://api.anthropic.com/v1",
      },
      {
        accept: "application/json",
        protocol: "anthropic",
      },
    );

    expect(headers.get("anthropic-beta")).toBe(
      "model-context-window-exceeded-2025-08-26",
    );
  });

  test("sends the context-window beta only to the official endpoint", async () => {
    const harness = anthropicHarness([doneEvents()], {
      credential: {
        accountId: null,
        apiFormat: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        secret: "anthropic-secret",
        source: "api_key",
      },
    });
    await harness.complete();

    // Pre-4.5 first-party models otherwise reject input+max_tokens context
    // overshoots; the documented beta degrades them to a stop reason.
    expect(harness.requests[0]?.headers.get("anthropic-beta")).toBe(
      "model-context-window-exceeded-2025-08-26",
    );
  });

  test("sends a cached Messages request and reads the streamed step", async () => {
    const harness = anthropicHarness([doneEvents()], { tools: ["read"] });

    const step = await harness.complete([
      { content: "Hello", role: "user" },
      {
        content: "Reading.",
        role: "assistant",
        toolCalls: [
          { arguments: '{"path":"SETUP.md"}', id: "read-call", name: "read" },
        ],
      },
      {
        content: "# Q Mush setup",
        role: "tool",
        toolCallId: "read-call",
        toolName: "read",
      },
    ]);

    expect(step).toEqual(
      providerStep("Done.", {
        contextTokens: 1_000,
        tokenUsage: {
          cacheWriteInputTokens: 40,
          cachedInputTokens: 900,
          inputTokens: 1_000,
          outputTokens: 5,
        },
      }),
    );

    const request = harness.requests[0];
    expect(request?.url).toBe(`${BASE_URL}/messages`);
    expect(request?.headers.get("anthropic-version")).toBe("2023-06-01");
    // Proxies and gateways 400 on unknown beta names; the context-window
    // beta stays first-party-only.
    expect(request?.headers.has("anthropic-beta")).toBe(false);
    expect(request?.headers.get("x-api-key")).toBe("anthropic-secret");
    expect(request?.headers.has("authorization")).toBe(false);

    const body = await recordRequestBody(harness, 0);
    // No reasoning parameter and no invented output budget: without catalog
    // metadata the provider's own defaults govern.
    expectAbsentProperties(body, ["max_tokens", "output_config", "thinking"]);
    expect(body["stream"]).toBe(true);
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body["system"]).toEqual(cachedText(AGENT_SYSTEM_PROMPT));
    const tools = body["tools"];
    if (!Array.isArray(tools)) {
      throw new Error("The captured tools were not an array");
    }
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      cache_control: TEST_PROMPT_CACHE_CONTROL,
      name: "read",
    });
    expect(tools[0]).toHaveProperty("input_schema");
    expect(body["messages"]).toEqual([
      cachedTextMessage("user", "Hello"),
      {
        content: [
          { text: "Reading.", type: "text" },
          {
            id: "read-call",
            input: { path: "SETUP.md" },
            name: "read",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            cache_control: TEST_PROMPT_CACHE_CONTROL,
            content: "# Q Mush setup",
            tool_use_id: "read-call",
            type: "tool_result",
          },
        ],
        role: "user",
      },
    ]);
  });

  test("streams tool calls and thinking from Messages events", async () => {
    const deltas: string[] = [];
    const harness = anthropicHarness(
      [
        anthropicEvents([
          {
            message: { usage: { input_tokens: 12 } },
            type: "message_start",
          },
          {
            content_block: { thinking: "", type: "thinking" },
            index: 0,
            type: "content_block_start",
          },
          {
            delta: { thinking: "Inspect first.", type: "thinking_delta" },
            index: 0,
            type: "content_block_delta",
          },
          {
            content_block: { id: "call-9", name: "read", type: "tool_use" },
            index: 1,
            type: "content_block_start",
          },
          {
            delta: { partial_json: '{"path":', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta",
          },
          {
            delta: { partial_json: '"src"}', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta",
          },
          { type: "message_delta", usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]),
      ],
      {
        onDelta: (delta) => {
          deltas.push(delta.thinking);
        },
      },
    );

    const step = await harness.complete([{ content: "Go", role: "user" }]);

    expect(step.thinking).toBe("Inspect first.");
    expect(step.toolCalls).toEqual([
      { arguments: '{"path":"src"}', id: "call-9", name: "read" },
    ]);
    expect(step.tokenUsage).toEqual({
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 12,
      outputTokens: 9,
    });
    expect(deltas.join("")).toBe("Inspect first.");
  });

  test("maps a selected reasoning effort to output_config and thinking", async () => {
    expect(await effortRequestBody("xhigh")).toMatchObject({
      // Adaptive thinking on the provider's default budget; effort steers
      // spend, and "summarized" display opts out of omitted-by-default text.
      output_config: { effort: "xhigh" },
      thinking: { display: "summarized", type: "adaptive" },
    });
  });

  test('sends no reasoning parameters for the "none" effort', async () => {
    const body = await effortRequestBody("none");
    expectAbsentProperties(body, ["output_config", "thinking"]);
  });

  test("maps image and PDF attachments to native content blocks", async () => {
    const harness = anthropicHarness([doneEvents()]);
    await harness.complete([
      {
        attachments: [
          { data: "aW1n", mediaType: "image/png", name: "shot.png" },
          { data: "cGRm", mediaType: "application/pdf", name: "spec.pdf" },
          { data: "dHh0", mediaType: "text/plain", name: "notes.txt" },
        ],
        content: "See the files",
        role: "user",
      },
    ]);

    const body = await harness.requestBody(0);
    const messages = isRecord(body) ? body["messages"] : undefined;
    if (!Array.isArray(messages) || !isRecord(messages[0])) {
      throw new Error("The captured messages were invalid");
    }
    const content = messages[0]["content"];
    if (!Array.isArray(content)) {
      throw new Error("The captured content was not an array");
    }
    // Image and PDF map to native blocks; other modalities fall through to
    // the attachment fallback instead of the request body.
    expect(content).toHaveLength(3);
    expect(content[1]).toEqual({
      source: { data: "aW1n", media_type: "image/png", type: "base64" },
      type: "image",
    });
    // The final part carries the rolling transcript-tail cache breakpoint.
    expect(content[2]).toEqual({
      cache_control: { ttl: "1h", type: "ephemeral" },
      source: { data: "cGRm", media_type: "application/pdf", type: "base64" },
      title: "spec.pdf",
      type: "document",
    });
  });

  test('maps the OpenAI-only "minimal" effort to "low"', async () => {
    // The Messages API rejects "minimal": valid levels are low through max.
    expect(await effortRequestBody("minimal")).toMatchObject({
      output_config: { effort: "low" },
    });
  });

  test("sends effort without adaptive thinking when the model rejects it", async () => {
    const body = await effortRequestBody("xhigh", false);

    expect(body).toMatchObject({ output_config: { effort: "xhigh" } });
    expect(body).not.toHaveProperty("thinking");
  });

  test("surfaces a provider effort rejection", async () => {
    const harness = anthropicHarness(
      [
        invalidRequestResponse(
          "This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.",
        ),
      ],
      { reasoningEffort: "xhigh" },
    );

    await expect(harness.complete()).rejects.toThrow(
      "does not support effort level",
    );
    expect(harness.requests).toHaveLength(1);
  });

  test.each(["max_tokens", "model_context_window_exceeded"] as const)(
    "reports %s stops as truncation",
    async (stopReason) => {
      const harness = anthropicHarness([
        textStopEvents({
          stopReason,
          text: "Partial",
          usage: { input_tokens: 3 },
        }),
      ]);

      const step = await harness.complete();

      expect(step.content).toBe("Partial");
      expect(step.truncation).toBe(stopReason);
    },
  );

  async function completedTruncation(
    response: Response,
  ): Promise<string | undefined> {
    const step = await anthropicHarness([response]).complete();
    return step.truncation;
  }

  test("reports no truncation for an end_turn stop", async () => {
    expect(await completedTruncation(doneEvents())).toBeUndefined();
  });

  test("reports truncation from a non-streaming stopped message", async () => {
    const stopped = Response.json({
      content: [{ text: "Cut short.", type: "text" }],
      role: "assistant",
      stop_reason: "max_tokens",
      type: "message",
      usage: { input_tokens: 4, output_tokens: 2 },
    });

    expect(await completedTruncation(stopped)).toBe("max_tokens");
  });

  test("parses a non-streaming JSON message response", async () => {
    const harness = anthropicHarness([
      Response.json({
        content: [
          { text: "Plain.", type: "text" },
          {
            id: "call-2",
            input: { command: "ls" },
            name: "bash",
            type: "tool_use",
          },
        ],
        role: "assistant",
        type: "message",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    ]);

    const step = await harness.complete([{ content: "Hi", role: "user" }]);

    expect(step.content).toBe("Plain.");
    expect(step.toolCalls).toEqual([
      { arguments: '{"command":"ls"}', id: "call-2", name: "bash" },
    ]);
    expect(step.tokenUsage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });
});
