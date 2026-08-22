import { describe, expect, test } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import {
  ANTHROPIC_READ_CALL,
  ANTHROPIC_TEST_CREDENTIAL,
  ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
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
  cachedTextMessage,
  chatCompletionsDone,
  TEST_PROMPT_CACHE_CONTROL,
} from "./prompt-cache-fixtures.ts";

const KNOWN_MODEL = KNOWN_ANTHROPIC_MODEL;
const SIGNED_REPLAY = SIGNED_ANTHROPIC_REPLAY;
const UNSAFE_TOOL_REPLAY_ERROR =
  "The Anthropic assistant tool turn cannot be continued safely";

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
      thinkingOnlyAssistant(replay),
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
      { content: replay.blocks, role: "assistant" },
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
});
