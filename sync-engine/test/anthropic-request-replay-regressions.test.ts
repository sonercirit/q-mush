import { describe, expect, test } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { completionMessages } from "../../sync-engine/agent-completion.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { anthropicRequestBody } from "../../sync-engine/anthropic-request.ts";
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
  capturedRequestRecord,
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

function replayTextAssistant() {
  return {
    content: "Reading.",
    providerReplay: replayWithoutClientTool(),
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
): Promise<readonly unknown[]> {
  const harness = signedReplayHarness();
  await harness.complete(messages);
  const captured = (await capturedRequestRecord(harness, 0))["messages"];
  if (!Array.isArray(captured)) {
    throw new Error("The captured messages were not an array");
  }
  return Array.from<unknown>(captured);
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

function directRequestBody(messages: readonly AgentConversationMessage[]) {
  return anthropicRequestBody({
    adaptiveThinking: null,
    credential: ANTHROPIC_TEST_CREDENTIAL,
    credentialFingerprint: ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
    maxOutputTokens: null,
    messages,
    model: KNOWN_MODEL,
    provider: "generic",
    reasoningEffort: undefined,
    resolvedModel: KNOWN_MODEL,
    stream: true,
    systemPrompt: "System",
    tools: [],
  });
}

function expectUnsignedReplay(content: unknown): void {
  const serialized = JSON.stringify(content);
  for (const privateField of ["caller", "omitted-signature", "redacted-data"]) {
    expect(serialized).not.toContain(privateField);
  }
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

function mismatchedReplayConversation() {
  return [
    { content: "Hello", role: "user" } as const,
    {
      ...readAssistant(SIGNED_REPLAY),
      toolCalls: [{ ...ANTHROPIC_READ_CALL, arguments: '{"path":"OTHER.md"}' }],
    },
    readToolResult("Setup"),
  ];
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

  test("marks the trailing eligible replay block before ineligible signed blocks", async () => {
    const [thinking, redactedThinking, text, toolUse] = SIGNED_REPLAY.blocks;
    if (
      thinking === undefined ||
      redactedThinking === undefined ||
      text === undefined ||
      toolUse === undefined
    ) {
      throw new Error("The signed replay fixture was incomplete");
    }
    const replay = {
      ...SIGNED_REPLAY,
      blocks: [text, toolUse, thinking, redactedThinking],
    };
    const { content } = await completeReplayRequest({
      providerReplay: replay,
      toolContent: "",
    });

    expect(content).toEqual([
      replay.blocks[0],
      { ...replay.blocks[1], cache_control: TEST_PROMPT_CACHE_CONTROL },
      replay.blocks[2],
      replay.blocks[3],
    ]);
  });

  test("leaves an all-ineligible replay breakpoint byte-for-byte unchanged", async () => {
    const baseReplay = thinkingOnlyReplay();
    const [thinking, redactedThinking] = baseReplay.blocks;
    if (thinking?.type !== "thinking" || redactedThinking === undefined) {
      throw new Error("The thinking replay fixture was incomplete");
    }
    const replay = {
      ...baseReplay,
      blocks: [
        { text: " ", type: "text" as const },
        { ...thinking, thinking: "Thinking." },
        redactedThinking,
      ],
    };
    const messages = await replayOnlyMessages([
      { content: "First", role: "user" },
      { ...thinkingOnlyAssistant(replay), content: " " },
      { content: "Middle", role: "user" },
      replayTextAssistant(),
    ]);

    expect(messages[0]).toEqual(cachedTextMessage("user", "First"));
    expect(messages[1]).toEqual({
      content: replay.blocks.slice(1),
      role: "assistant",
    });
    expect(messages.at(2)).toEqual(cachedTextMessage("user", "Middle"));
    expect(messages.at(3)).toEqual({
      content: replayWithoutClientTool().blocks,
      role: "assistant",
    });
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
      replayTextAssistant(),
    ];
    const messages = await replayOnlyMessages(history);

    expect(messages).toEqual([
      { content: [{ text: "First", type: "text" }], role: "user" },
      { content: replay.blocks, role: "assistant" },
      {
        content: [
          {
            cache_control: TEST_PROMPT_CACHE_CONTROL,
            text: "Middle",
            type: "text",
          },
          {
            cache_control: TEST_PROMPT_CACHE_CONTROL,
            text: "Last",
            type: "text",
          },
        ],
        role: "user",
      },
      { content: replayWithoutClientTool().blocks, role: "assistant" },
    ]);
  });

  test("keeps cache breakpoints outside every merged trailing replay", () => {
    const replayFor = (text: string) => ({
      ...replayWithoutClientTool(),
      blocks: replayWithoutClientTool().blocks.map((block) =>
        block.type === "text" ? { ...block, text } : block,
      ),
    });
    const firstReplay = replayFor("First reply.");
    const secondReplay = replayFor("Second reply.");
    const thirdReplay = replayFor("Third reply.");
    const body = directRequestBody([
      { content: "Before replays", role: "user" },
      {
        content: "First reply.",
        providerReplay: firstReplay,
        role: "assistant",
        toolCalls: [],
      },
      {
        content: "Second reply.",
        providerReplay: secondReplay,
        role: "assistant",
        toolCalls: [],
      },
      {
        content: "Third reply.",
        providerReplay: thirdReplay,
        role: "assistant",
        toolCalls: [],
      },
    ]);

    expect(body).toMatchObject({
      messages: [
        cachedTextMessage("user", "Before replays"),
        {
          content: [
            ...firstReplay.blocks,
            ...secondReplay.blocks,
            ...thirdReplay.blocks,
          ],
          role: "assistant",
        },
      ],
    });
    if (
      typeof body !== "object" ||
      body === null ||
      !("messages" in body) ||
      !Array.isArray(body.messages)
    ) {
      throw new Error("The request messages were not an array");
    }
    expect(JSON.stringify(body.messages[1])).not.toContain("cache_control");
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

  test("drops invalid replay during completion sanitization", () => {
    for (const conversation of [
      staleReplayConversation(),
      mismatchedReplayConversation(),
    ]) {
      const messages = completionMessages([conversation], KNOWN_MODEL);
      expect(messages[1]).not.toHaveProperty("providerReplay");
    }
  });

  test("fails request assembly closed when replay differs from its assistant", () => {
    expect(() => directRequestBody(mismatchedReplayConversation())).toThrow(
      UNSAFE_TOOL_REPLAY_ERROR,
    );
  });

  test("fails closed when tool-call sanitization changes the assistant", () =>
    expectReplayOutcome(mismatchedReplayConversation(), true));

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

  test("does not recover a container across a non-tool intervening turn", () => {
    const messages = [
      ...containedReplayConversation(),
      { content: "Later question", role: "user" as const },
      readToolResult("Late result"),
    ];

    expect(directRequestBody(messages)).not.toHaveProperty("container");
  });
});
