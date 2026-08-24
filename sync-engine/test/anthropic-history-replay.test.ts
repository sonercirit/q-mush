import { describe, expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentToolCall,
} from "../../shared/agent-loop.ts";
import type { AnthropicAssistantReplay } from "../../shared/anthropic-replay.ts";
import { createModelConversationCompactor } from "../../sync-engine/agent-compaction.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import {
  ANTHROPIC_READ_CALL,
  ANTHROPIC_TEST_CREDENTIAL,
  ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
  ANTHROPIC_TEST_PROVENANCE,
  anthropicHarness,
  doneAnthropicEvents,
  KNOWN_ANTHROPIC_MODEL,
  thinkingReplayBlock,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import {
  anthropicAssistant,
  SIGNED_ANTHROPIC_REPLAY,
} from "./anthropic-replay-request-helpers.ts";

const REQUEST_ALIAS = "claude-current";
const MOVED_MODEL = "claude-moved";
const SECOND_CALL = {
  arguments: '{"path":"SECOND.md"}',
  id: "second-call",
  name: "read",
} as const;

function toolResult(call: AgentToolCall, content: string) {
  return {
    content,
    role: "tool" as const,
    toolCallId: call.id,
    toolName: call.name,
  };
}

function completedToolHistory(
  providerReplay?: AnthropicAssistantReplay,
): readonly AgentConversationMessage[] {
  return [
    { content: "Inspect", role: "user" },
    anthropicAssistant(providerReplay),
    toolResult(ANTHROPIC_READ_CALL, "Setup"),
    { content: "A later request", role: "user" },
  ];
}

function replayToolCall(
  call: AgentToolCall,
  input: Readonly<Record<string, string>>,
) {
  return toolReplayBlock({ id: call.id, input, name: call.name });
}

function multiCallReplay(): AnthropicAssistantReplay {
  return {
    blocks: [
      thinkingReplayBlock("recent-signature"),
      { text: "Reading both.", type: "text" },
      replayToolCall(ANTHROPIC_READ_CALL, { path: "SETUP.md" }),
      replayToolCall(SECOND_CALL, { path: "SECOND.md" }),
    ],
    model: KNOWN_ANTHROPIC_MODEL,
    protocol: "anthropic",
    provenance: ANTHROPIC_TEST_PROVENANCE,
  };
}

function multiCallAssistant(replay: AnthropicAssistantReplay) {
  return {
    content: "Reading both.",
    providerReplay: replay,
    role: "assistant" as const,
    toolCalls: [ANTHROPIC_READ_CALL, SECOND_CALL],
  };
}

async function capturedBody(
  messages: readonly AgentConversationMessage[],
): Promise<unknown> {
  const harness = anthropicHarness([doneAnthropicEvents()]);
  await harness.complete(messages);
  return harness.requestBody(0);
}

function aliasModel(
  resolution: () => Response,
  requests: Request[],
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: ANTHROPIC_TEST_CREDENTIAL,
    credentialFingerprint: ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
    fetch: (request) => {
      requests.push(request);
      return Promise.resolve(
        request.method === "GET" ? resolution() : doneAnthropicEvents(),
      );
    },
    maxOutputTokens: null,
    model: REQUEST_ALIAS,
    provider: "generic",
  });
}

async function aliasRequestBody(
  resolution: () => Response,
  replay: AnthropicAssistantReplay,
): Promise<unknown> {
  const requests: Request[] = [];
  const model = aliasModel(resolution, requests);
  await model.complete(completedToolHistory(replay));
  return requests.find(({ method }) => method === "POST")?.json();
}

function expectPlainHistoricalAssistant(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).toContain('"type":"tool_use"');
  expect(serialized).not.toContain("omitted-signature");
}

describe("Anthropic historical replay degradation", () => {
  test("reconstructs a legacy completed tool turn without replay", async () => {
    expectPlainHistoricalAssistant(await capturedBody(completedToolHistory()));
  });

  test.each([
    [
      "when a proxy has no model retrieve route",
      () => new Response("missing", { status: 404 }),
    ],
    [
      "after an alias moves",
      () => Response.json({ id: MOVED_MODEL, type: "model" }),
    ],
  ] as const)(
    "reconstructs completed history %s",
    async (_label, resolution) => {
      const body = await aliasRequestBody(resolution, {
        ...SIGNED_ANTHROPIC_REPLAY,
        requestModel: REQUEST_ALIAS,
      });

      expectPlainHistoricalAssistant(body);
    },
  );

  test("ignores incompatible mid-history replay while validating the recent turn", async () => {
    const recent = multiCallReplay();
    const body = await capturedBody([
      ...completedToolHistory({
        ...SIGNED_ANTHROPIC_REPLAY,
        model: "obsolete-model",
      }),
      multiCallAssistant(recent),
      toolResult(ANTHROPIC_READ_CALL, "First"),
      toolResult(SECOND_CALL, "Second"),
    ]);
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("omitted-signature");
    expect(serialized).toContain("recent-signature");
  });

  test("accepts deduplicated interrupted results in completion order", async () => {
    const replay = multiCallReplay();
    const body = await capturedBody([
      { content: "Inspect", role: "user" },
      multiCallAssistant(replay),
      toolResult(SECOND_CALL, "Finished first"),
      toolResult(SECOND_CALL, "Duplicate recovery artifact"),
      toolResult(ANTHROPIC_READ_CALL, "Interrupted later"),
    ]);

    expect(JSON.stringify(body)).toContain("recent-signature");
  });

  test("compacts legacy completed tool history without replay", async () => {
    const harness = anthropicHarness([doneAnthropicEvents()]);
    const compactor = createModelConversationCompactor({
      complete: harness.complete,
    });

    await expect(
      compactor.compact(completedToolHistory()),
    ).resolves.toMatchObject({ summary: "Done." });
    expectPlainHistoricalAssistant(await harness.requestBody(0));
  });
});
