import { describe, expect, test } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { AGENT_SYSTEM_PROMPT } from "../../shared/agent-prompt.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  agentProviderRequestHeaders,
  ChatCompletionsAgentModel,
} from "../../sync-engine/agent-model.ts";
import {
  ANTHROPIC_READ_CALL,
  ANTHROPIC_TEST_BASE_URL,
  ANTHROPIC_TEST_CREDENTIAL,
  ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
  ANTHROPIC_TEST_PROVENANCE,
  anthropicHarness,
  doneAnthropicEvents,
  KNOWN_ANTHROPIC_MODEL,
} from "./anthropic-model-test-helpers.ts";
import {
  anthropicAssistant,
  anthropicReplayConversation,
  capturedAssistantContent,
  SIGNED_ANTHROPIC_REPLAY,
  signedReplayHarness,
} from "./anthropic-replay-request-helpers.ts";
import {
  cachedText,
  cachedTextMessage,
  chatCompletionsDone,
  TEST_PROMPT_CACHE_CONTROL,
} from "./prompt-cache-fixtures.ts";
import { providerStep } from "./provider-step-fixtures.ts";

const KNOWN_MODEL = KNOWN_ANTHROPIC_MODEL;
const SIGNED_REPLAY = SIGNED_ANTHROPIC_REPLAY;
const UNSAFE_TOOL_REPLAY_ERROR =
  "The Anthropic assistant tool turn cannot be replayed safely";

function readAssistant(providerReplay?: typeof SIGNED_REPLAY) {
  return anthropicAssistant(providerReplay);
}

function readToolResult(content: string) {
  return {
    content,
    role: "tool" as const,
    toolCallId: ANTHROPIC_READ_CALL.id,
    toolName: ANTHROPIC_READ_CALL.name,
  };
}

function replayConversation(options: {
  readonly providerReplay?: typeof SIGNED_REPLAY;
  readonly toolContent: string;
}) {
  return anthropicReplayConversation(options);
}

async function assistantContent(
  harness: ReturnType<typeof anthropicHarness>,
): Promise<unknown> {
  return capturedAssistantContent(harness);
}

function thinkingOnlyAssistant(replay: typeof SIGNED_REPLAY) {
  return {
    content: "",
    providerReplay: replay,
    role: "assistant" as const,
    toolCalls: [],
  };
}

function thinkingOnlyReplay() {
  return {
    ...SIGNED_REPLAY,
    blocks: SIGNED_REPLAY.blocks.slice(0, 2),
  };
}

async function replayOnlyMessages(
  messages: readonly AgentConversationMessage[],
): Promise<unknown> {
  const harness = signedReplayHarness();
  await harness.complete(messages);
  return (await requestRecord(harness, 0))["messages"];
}

async function completeReplayRequest(options: {
  readonly providerReplay: typeof SIGNED_REPLAY;
  readonly toolContent: string;
}) {
  const harness = signedReplayHarness();
  await harness.complete(replayConversation(options));
  return { content: await assistantContent(harness), harness };
}

async function captureOpenAiFormatReplayRequest(
  providerReplay: typeof SIGNED_REPLAY,
) {
  const capturedRequests: Request[] = [];
  const capture = (request: Request): Promise<Response> => {
    capturedRequests.push(request);
    return Promise.resolve(Response.json(chatCompletionsDone()));
  };
  const model = new ChatCompletionsAgentModel({
    credential: { ...ANTHROPIC_TEST_CREDENTIAL, apiFormat: "openai" },
    credentialFingerprint: ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
    fetch: capture,
    maxOutputTokens: null,
    model: "gpt-4.1-mini",
    provider: "generic",
  });
  await model.complete([
    { content: "Hello", role: "user" },
    anthropicAssistant(providerReplay),
    readToolResult("Setup"),
  ]);
  const captured = capturedRequests[0];
  if (captured === undefined) {
    throw new Error("No OpenAI request was captured");
  }
  const body: unknown = await captured.json();
  return body;
}

function expectAbsentProperties(
  body: unknown,
  properties: readonly string[],
): void {
  for (const property of properties) {
    expect(body).not.toHaveProperty(property);
  }
}

function expectUnsignedReplay(content: unknown): void {
  const serialized = JSON.stringify(content);
  for (const privateField of ["caller", "omitted-signature", "redacted-data"]) {
    expect(serialized).not.toContain(privateField);
  }
}

async function requestRecord(
  harness: ReturnType<typeof anthropicHarness>,
  index: number,
): Promise<Readonly<Record<string, unknown>>> {
  const body = await harness.requestBody(index);
  if (!isRecord(body)) {
    throw new Error("The captured body was not a record");
  }
  return body;
}

async function effortRequestBody(
  effort: "minimal" | "none" | "xhigh",
  adaptiveThinking: boolean | null = true,
): Promise<unknown> {
  const harness = anthropicHarness([doneAnthropicEvents()], {
    adaptiveThinking,
    reasoningEffort: effort,
  });
  await harness.complete();
  return harness.requestBody(0);
}

function officialAnthropicCredential() {
  return {
    ...ANTHROPIC_TEST_CREDENTIAL,
    baseUrl: "https://api.anthropic.com/v1",
  };
}

async function expectReplayOutcome(
  messages: readonly AgentConversationMessage[],
  unsafe: boolean,
): Promise<void> {
  const harness = signedReplayHarness();
  if (unsafe) {
    await expect(harness.complete(messages)).rejects.toThrow(
      UNSAFE_TOOL_REPLAY_ERROR,
    );
    expect(harness.requests).toHaveLength(0);
    return;
  }
  await harness.complete(messages);
  expectUnsignedReplay(await assistantContent(harness));
  expect(harness.requests).toHaveLength(1);
}

function replayWithoutClientTool() {
  return { ...SIGNED_REPLAY, blocks: SIGNED_REPLAY.blocks.slice(0, 3) };
}

function staleReplayConversation() {
  return replayConversation({
    providerReplay: { ...SIGNED_REPLAY, model: "claude-other" },
    toolContent: "Setup",
  });
}

function containedReplayConversation(
  toolCallId: string = ANTHROPIC_READ_CALL.id,
) {
  return replayConversation({
    providerReplay: { ...SIGNED_REPLAY, container: "container-1" },
    toolContent: "Setup",
  })
    .slice(0, -1)
    .map((message) =>
      message.role === "tool" ? { ...message, toolCallId } : message,
    );
}

async function replayContentForIdentity(
  options: Pick<
    NonNullable<Parameters<typeof anthropicHarness>[1]>,
    "credential" | "credentialFingerprint"
  >,
): Promise<unknown> {
  const harness = anthropicHarness([doneAnthropicEvents()], options);
  const replay = replayWithoutClientTool();
  await harness.complete([
    { content: "Hello", role: "user" },
    {
      content: "Reading.",
      providerReplay: replay,
      role: "assistant",
      toolCalls: [],
    },
    { content: "Continue", role: "user" },
  ]);
  return assistantContent(harness);
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

describe("anthropic-format generic provider", () => {
  test("sends the catalog max output tokens when the session carries them", async () => {
    const harness = anthropicHarness([doneAnthropicEvents()], {
      maxOutputTokens: 64_000,
    });
    await harness.complete();

    const body = await requestRecord(harness, 0);
    expect(body["max_tokens"]).toBe(64_000);
  });

  test("identifies a non-streaming Messages completion by protocol", () => {
    const headers = agentProviderRequestHeaders(
      "generic",
      officialAnthropicCredential(),
      { accept: "application/json", protocol: "anthropic" },
    );

    expect(headers.get("anthropic-beta")).toBe(
      "model-context-window-exceeded-2025-08-26",
    );
  });

  test("sends the context-window beta only to the official endpoint", async () => {
    const harness = anthropicHarness([doneAnthropicEvents()], {
      credential: officialAnthropicCredential(),
    });
    await harness.complete();

    // Pre-4.5 first-party models otherwise reject input+max_tokens context
    // overshoots; the documented beta degrades them to a stop reason.
    expect(harness.requests[0]?.headers.get("anthropic-beta")).toBe(
      "model-context-window-exceeded-2025-08-26",
    );
  });

  test("sends a cached Messages request and reads the streamed step", async () => {
    const harness = anthropicHarness([doneAnthropicEvents()], {
      tools: ["read"],
    });

    const step = await harness.complete([
      { content: "Hello", role: "user" },
      readAssistant(SIGNED_REPLAY),
      readToolResult("# Q Mush setup"),
    ]);

    expect(step).toEqual(
      providerStep("Done.", {
        contextTokens: 1_000,
        providerReplay: {
          blocks: [{ text: "Done.", type: "text" }],
          model: KNOWN_MODEL,
          protocol: "anthropic",
          provenance: ANTHROPIC_TEST_PROVENANCE,
        },
        tokenUsage: {
          cacheWriteInputTokens: 40,
          cachedInputTokens: 900,
          inputTokens: 1_000,
          outputTokens: 5,
        },
      }),
    );

    const request = harness.requests[0];
    expect(request?.url).toBe(`${ANTHROPIC_TEST_BASE_URL}/messages`);
    expect(request?.headers.get("anthropic-version")).toBe("2023-06-01");
    // Proxies and gateways 400 on unknown beta names; the context-window
    // beta stays first-party-only.
    expect(request?.headers.has("anthropic-beta")).toBe(false);
    expect(request?.headers.get("x-api-key")).toBe("anthropic-secret");
    expect(request?.headers.has("authorization")).toBe(false);

    const body = await requestRecord(harness, 0);
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
        content: SIGNED_REPLAY.blocks,
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

  test("marks an eligible replay block without mutating signed thinking", async () => {
    const { content } = await completeReplayRequest({
      providerReplay: SIGNED_REPLAY,
      toolContent: "",
    });

    const expected = SIGNED_REPLAY.blocks.map((block, index, blocks) =>
      index === blocks.length - 1
        ? { ...block, cache_control: TEST_PROMPT_CACHE_CONTROL }
        : block,
    );
    expect(content).toEqual(expected);
    if (!Array.isArray(content)) {
      throw new Error("The replayed content was not an array");
    }
    expect(content.slice(0, -1)).toEqual(SIGNED_REPLAY.blocks.slice(0, -1));
  });

  test("keeps a thinking-only replay through completion sanitization", async () => {
    const replay = thinkingOnlyReplay();
    const messages = await replayOnlyMessages([
      thinkingOnlyAssistant(replay),
      { content: "Continue", role: "user" },
    ]);

    expect(messages).toEqual([
      { content: replay.blocks, role: "assistant" },
      cachedTextMessage("user", "Continue"),
    ]);
  });

  test("moves a replay-only breakpoint to the nearest eligible message", async () => {
    const replay = thinkingOnlyReplay();
    const history: AgentConversationMessage[] = [
      { content: "First", role: "user" },
      thinkingOnlyAssistant(replay),
      { content: "Middle", role: "user" },
      { content: "Last", role: "user" },
    ];
    const messages = await replayOnlyMessages(history);

    expect(messages).toEqual([
      cachedTextMessage("user", "First"),
      { content: replay.blocks, role: "assistant" },
      {
        content: [
          { text: "Middle", type: "text" },
          {
            cache_control: TEST_PROMPT_CACHE_CONTROL,
            text: "Last",
            type: "text",
          },
        ],
        role: "user",
      },
    ]);
  });

  test("omits signed replay only after rotation-sensitive identity changes", async () => {
    for (const [credential, credentialFingerprint] of [
      [
        { ...ANTHROPIC_TEST_CREDENTIAL, id: "other-credential" },
        "other-fingerprint",
      ],
      [
        {
          ...ANTHROPIC_TEST_CREDENTIAL,
          baseUrl: "https://other-anthropic.example.test/v1",
        },
        ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
      ],
      [
        { ...ANTHROPIC_TEST_CREDENTIAL, secret: "rotated-secret" },
        "rotated-fingerprint",
      ],
    ] as const) {
      const content = await replayContentForIdentity({
        credential,
        credentialFingerprint,
      });
      expectUnsignedReplay(content);
    }
  });

  test("does not derive replay provenance from plaintext secret", async () => {
    const content = await replayContentForIdentity({
      credential: {
        ...ANTHROPIC_TEST_CREDENTIAL,
        secret: "same-stored-fingerprint-new-plaintext",
      },
      credentialFingerprint: ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
    });

    expect(JSON.stringify(content)).toContain("omitted-signature");
  });

  test("degrades stale signed tool replay after a historical model change", () =>
    expectReplayOutcome(staleReplayConversation(), false));

  test("fails closed when tool-call sanitization changes the assistant", () =>
    expectReplayOutcome(
      [
        { content: "Hello", role: "user" },
        {
          ...readAssistant(SIGNED_REPLAY),
          toolCalls: [
            { ...ANTHROPIC_READ_CALL, arguments: '{"path":"OTHER.md"}' },
          ],
        },
        readToolResult("Setup"),
      ],
      true,
    ));

  test("keeps private replay metadata out of OpenAI-format requests", async () => {
    const body = await captureOpenAiFormatReplayRequest(SIGNED_REPLAY);

    expect(JSON.stringify(body)).not.toContain("providerReplay");
    expect(JSON.stringify(body)).not.toContain("omitted-signature");
  });

  test("fails a trailing client-tool continuation closed without exact replay", () =>
    expectReplayOutcome(
      replayConversation({ toolContent: "Setup" }).slice(0, -1),
      true,
    ));

  test("fails a stale trailing client-tool continuation closed", () =>
    expectReplayOutcome(staleReplayConversation().slice(0, -1), true));

  test("recovers a continuation container through trailing tool results", async () => {
    const harness = signedReplayHarness();
    await harness.complete(containedReplayConversation());

    await expect(harness.requestBody(0)).resolves.toMatchObject({
      container: "container-1",
    });
  });

  test("rejects a continuation container when the result IDs do not match", () =>
    expectReplayOutcome(containedReplayConversation("different-call"), true));

  test("does not recover a container across a non-tool intervening turn", async () => {
    const harness = signedReplayHarness();
    await harness.complete([
      ...containedReplayConversation(),
      { content: "Later question", role: "user" },
      readToolResult("Late result"),
    ]);

    await expect(harness.requestBody(0)).resolves.not.toHaveProperty(
      "container",
    );
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
    const harness = anthropicHarness([doneAnthropicEvents()]);
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
});
