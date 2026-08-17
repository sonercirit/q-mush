import { describe, expect, test, vi } from "vitest";
import {
  runAgentLoop,
  type AgentConversationMessage,
  type AgentModelStep,
} from "../../shared/agent-loop.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { resolveAnthropicModel } from "../../sync-engine/anthropic-model-resolution.ts";
import {
  ANTHROPIC_TEST_CREDENTIAL,
  ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
  ANTHROPIC_TEST_PROVENANCE,
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicMessageStart,
} from "./anthropic-model-test-helpers.ts";
import {
  anthropicJsonResponse,
  finishedAnthropicStep,
  streamedAnthropicReadEvents,
} from "./anthropic-response-event-fixtures.ts";

const REQUEST_ALIAS = "claude-current";
const FIRST_SNAPSHOT = "claude-snapshot-20260101";
const MOVED_SNAPSHOT = "claude-snapshot-20260201";
const THINKING = "Inspect first.";
const SIGNATURE = "signed-thinking";
const CALL_ID = "read-call";

const DEFAULT_COMPLETION_BLOCKS = [{ text: "Done.", type: "text" }] as const;
const UNRESOLVED_MODEL_RESPONSES = [
  ["a missing retrieve route", () => new Response("missing", { status: 404 })],
  ["a malformed retrieve response", () => Response.json({ type: "model" })],
] as const;

const SIGNED_THINKING = {
  signature: SIGNATURE,
  thinking: THINKING,
  type: "thinking",
} as const;
const READ_TOOL = {
  id: CALL_ID,
  input: {},
  name: "read",
  type: "tool_use",
} as const;

function signedToolBlocks() {
  return [SIGNED_THINKING, READ_TOOL] as const;
}

function streamedThinking(options: {
  readonly signature: boolean;
  readonly stopped?: boolean;
}): readonly unknown[] {
  return [
    anthropicBlockStart(0, { thinking: "", type: "thinking" }),
    anthropicBlockDelta(0, {
      thinking: THINKING,
      type: "thinking_delta",
    }),
    ...(options.signature
      ? [
          anthropicBlockDelta(0, {
            signature: SIGNATURE,
            type: "signature_delta",
          }),
        ]
      : []),
    ...(options.stopped === false ? [] : [anthropicBlockStop(0)]),
  ];
}

function streamedStep(
  blocks: readonly unknown[],
  toolIndex: number,
  responseModel = FIRST_SNAPSHOT,
): AgentModelStep {
  return finishedAnthropicStep(
    [
      anthropicMessageStart(1, undefined, responseModel),
      ...blocks,
      ...streamedAnthropicReadEvents(CALL_ID, toolIndex),
      { type: "message_stop" },
    ],
    REQUEST_ALIAS,
  );
}

function streamedSignedToolStep(responseModel: string): AgentModelStep {
  return streamedStep(streamedThinking({ signature: true }), 1, responseModel);
}

async function responseStep(
  response: Response,
  requestModel = REQUEST_ALIAS,
): Promise<AgentModelStep> {
  const event: unknown = await response.json();
  return finishedAnthropicStep([event], requestModel);
}

function jsonSignedToolStep(responseModel: string): Promise<AgentModelStep> {
  return responseStep(
    anthropicJsonResponse({ blocks: signedToolBlocks(), model: responseModel }),
  );
}

async function expectNoToolSideEffect(
  model: Pick<ChatCompletionsAgentModel, "complete">,
): Promise<void> {
  const executeTool = vi.fn(() => Promise.resolve("unsafe side effect"));
  const loop = runAgentLoop({
    executeTool,
    initialMessages: [{ content: "Inspect", role: "user" }],
    model,
    recordMessage: () => undefined,
  });

  await expect(loop).rejects.toThrow("cannot be continued safely");
  expect(executeTool).not.toHaveBeenCalled();
}

async function expectNoUnsafeContinuation(step: AgentModelStep): Promise<void> {
  const complete = vi.fn().mockResolvedValueOnce(step);

  await expectNoToolSideEffect({ complete });
  expect(complete).toHaveBeenCalledTimes(1);
}

function unsupportedStream(): AgentModelStep {
  return streamedStep(
    [
      ...streamedThinking({ signature: true }),
      anthropicBlockStart(1, {
        encrypted: "future-data",
        type: "future_block",
      }),
      anthropicBlockStop(1),
    ],
    2,
  );
}

function unsupportedJson(): Promise<AgentModelStep> {
  return responseStep(
    anthropicJsonResponse({
      blocks: [
        SIGNED_THINKING,
        { encrypted: "future-data", type: "future_block" },
        READ_TOOL,
      ],
    }),
  );
}

interface CapturedRequests {
  readonly completion: Request;
  readonly resolution: Request;
}

function modelRequestCount(
  requests: readonly Request[],
  method: "GET" | "POST",
): number {
  return requests.filter((request) => request.method === method).length;
}

function modelOptions(fetch: (request: Request) => Promise<Response>) {
  return {
    credential: ANTHROPIC_TEST_CREDENTIAL,
    credentialFingerprint: ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
    fetch,
    maxOutputTokens: null,
    model: REQUEST_ALIAS,
    provider: "generic" as const,
  };
}

function testModel(
  response: (request: Request) => Response,
  requests: Request[],
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel(
    modelOptions((request) => {
      requests.push(request);
      return Promise.resolve(response(request));
    }),
  );
}

function unresolvedModel(
  unresolvedResponse: () => Response,
  completionBlocks: readonly Readonly<
    Record<string, unknown>
  >[] = DEFAULT_COMPLETION_BLOCKS,
): { readonly model: ChatCompletionsAgentModel; readonly requests: Request[] } {
  const requests: Request[] = [];
  return {
    model: testModel((request) => {
      return request.method === "GET"
        ? unresolvedResponse()
        : modelCompletion(FIRST_SNAPSHOT, completionBlocks);
    }, requests),
    requests,
  };
}

async function expectUnresolvedToolIdentityFailsClosed(
  unresolvedResponse: () => Response,
): Promise<void> {
  const { model, requests } = unresolvedModel(
    unresolvedResponse,
    signedToolBlocks(),
  );
  await expectNoToolSideEffect(model);
  expect({
    gets: modelRequestCount(requests, "GET"),
    posts: modelRequestCount(requests, "POST"),
  }).toEqual({ gets: 1, posts: 1 });
}

function aliasReplayMessage(): AgentConversationMessage {
  return {
    content: "Answer.",
    providerReplay: {
      blocks: [SIGNED_THINKING, { text: "Answer.", type: "text" }],
      model: FIRST_SNAPSHOT,
      protocol: "anthropic",
      provenance: ANTHROPIC_TEST_PROVENANCE,
      requestModel: REQUEST_ALIAS,
    },
    role: "assistant",
    toolCalls: [],
  };
}

function modelCompletion(
  model: string,
  blocks: readonly Readonly<
    Record<string, unknown>
  >[] = DEFAULT_COMPLETION_BLOCKS,
): Response {
  return anthropicJsonResponse({ blocks, model });
}

function preResolvedModel(requests: Request[]): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    ...modelOptions((request) => {
      requests.push(request);
      return Promise.resolve(modelCompletion(FIRST_SNAPSHOT));
    }),
    resolvedModel: FIRST_SNAPSHOT,
  });
}

function providerResponse(
  request: Request,
  resolvedModel: string,
  completion: () => Response,
): Response {
  return request.method === "GET"
    ? Response.json({ id: resolvedModel, type: "model" })
    : completion();
}

async function resolvedReplayRequest(
  resolvedModel: string,
): Promise<CapturedRequests> {
  const requests: Request[] = [];
  const respond = (request: Request): Response =>
    providerResponse(request, resolvedModel, () =>
      modelCompletion(resolvedModel),
    );
  const model = testModel(respond, requests);
  await model.complete([
    { content: "Inspect", role: "user" },
    aliasReplayMessage(),
    { content: "Continue", role: "user" },
  ]);
  const resolution = requests.find(({ method }) => method === "GET");
  const completion = requests.find(({ method }) => method === "POST");
  if (resolution === undefined || completion === undefined) {
    throw new Error("The expected Anthropic requests were not captured");
  }
  return { completion, resolution };
}

async function requestContainsSignature(resolvedModel: string) {
  const captured = await resolvedReplayRequest(resolvedModel);
  return {
    resolution: captured.resolution,
    signed: JSON.stringify(await captured.completion.json()).includes(
      SIGNATURE,
    ),
  };
}

function unsignedStream(): AgentModelStep {
  return streamedStep(streamedThinking({ signature: false }), 1);
}

function incompleteStream(): AgentModelStep {
  return streamedStep(
    [
      anthropicBlockStart(0, { text: "", type: "text" }),
      anthropicBlockDelta(0, {
        text: "Inspecting.",
        type: "text_delta",
      }),
    ],
    1,
  );
}

function expectBoundModel(step: AgentModelStep): void {
  expect(step.providerReplay).toMatchObject({
    model: FIRST_SNAPSHOT,
    provenance: ANTHROPIC_TEST_PROVENANCE,
    requestModel: REQUEST_ALIAS,
  });
}

describe("Anthropic replay safety", () => {
  test.each([
    ["streamed", () => streamedSignedToolStep(FIRST_SNAPSHOT)],
    ["JSON", () => jsonSignedToolStep(FIRST_SNAPSHOT)],
  ] as const)(
    "binds a %s alias response replay to its authoritative model",
    async (_format, readStep) => {
      expectBoundModel(await readStep());
    },
  );

  test("captures alias movement as a different authoritative replay model", () => {
    const models = [FIRST_SNAPSHOT, MOVED_SNAPSHOT].map(
      (model) => streamedSignedToolStep(model).providerReplay?.model,
    );
    expect(models).toEqual([FIRST_SNAPSHOT, MOVED_SNAPSHOT]);
  });

  test("replays an alias only while its current resolution still matches", async () => {
    const retained = await requestContainsSignature(FIRST_SNAPSHOT);
    const moved = await requestContainsSignature(MOVED_SNAPSHOT);

    expect({
      key: retained.resolution.headers.get("x-api-key"),
      signedAfterMove: moved.signed,
      signedWhileCurrent: retained.signed,
      url: retained.resolution.url,
      version: retained.resolution.headers.get("anthropic-version"),
    }).toEqual({
      key: "anthropic-secret",
      signedAfterMove: false,
      signedWhileCurrent: true,
      url: "https://anthropic.example.test/v1/models/claude-current",
      version: "2023-06-01",
    });
  });

  test.each(UNRESOLVED_MODEL_RESPONSES)(
    "continues Messages requests after %s and caches the unresolved result",
    async (_label, unresolvedResponse) => {
      const { model, requests } = unresolvedModel(unresolvedResponse);

      await model.complete([{ content: "First", role: "user" }]);
      await model.complete([{ content: "Second", role: "user" }]);

      expect(modelRequestCount(requests, "GET")).toBe(1);
      expect(modelRequestCount(requests, "POST")).toBe(2);
    },
  );

  test.each(UNRESOLVED_MODEL_RESPONSES)(
    "fails signed client tools closed after %s",
    async (_label, unresolvedResponse) => {
      await expectUnresolvedToolIdentityFailsClosed(unresolvedResponse);
    },
  );

  test("propagates a caller abort while resolving an alias", async () => {
    const controller = new AbortController();
    const resolution = resolveAnthropicModel({
      credential: ANTHROPIC_TEST_CREDENTIAL,
      fetch: () => {
        controller.abort();
        return Promise.resolve(new Response("missing", { status: 404 }));
      },
      model: REQUEST_ALIAS,
      provider: "generic",
      signal: controller.signal,
    });

    await expect(resolution).rejects.toMatchObject({ name: "AbortError" });
  });

  test("uses a pre-resolved model without retrieving the alias again", async () => {
    const requests: Request[] = [];
    const model = preResolvedModel(requests);

    const messages: readonly AgentConversationMessage[] = [
      { content: "Inspect", role: "user" },
    ];
    await model.complete(messages);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
  });

  test("does not follow up an unsafe pause_turn internally", async () => {
    const requests: Request[] = [];
    const paused = () =>
      anthropicJsonResponse({
        blocks: [{ encrypted: "future-data", type: "future_block" }, READ_TOOL],
        model: FIRST_SNAPSHOT,
        stopReason: "pause_turn",
      });
    const model = testModel(
      (request) => providerResponse(request, FIRST_SNAPSHOT, paused),
      requests,
    );

    const step = await model.complete([
      { content: "Inspect unsafe pause", role: "user" },
    ]);
    expect({
      continuation: step.providerContinuation,
      requestCount: requests.length,
    }).toEqual({
      continuation: "anthropic_replay_unavailable",
      requestCount: 2,
    });
  });

  test("fails closed when the response model is unavailable", async () => {
    const response = anthropicJsonResponse({ blocks: signedToolBlocks() });
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null) {
      throw new Error("The Anthropic fixture was invalid");
    }
    Reflect.deleteProperty(value, "model");
    await expectNoUnsafeContinuation(
      finishedAnthropicStep([value], REQUEST_ALIAS),
    );
  });

  test.each([
    ["streamed unsupported", unsupportedStream],
    ["JSON unsupported", unsupportedJson],
    ["streamed unsigned", unsignedStream],
    ["streamed incomplete", incompleteStream],
  ] as const)(
    "fails a %s client-tool turn closed when exact replay is unavailable",
    async (_format, readStep) => {
      const step = await readStep();
      expect(step.providerReplay).toBeUndefined();
      expect(step.toolCalls).toEqual([
        { arguments: "{}", id: CALL_ID, name: "read" },
      ]);
      await expectNoUnsafeContinuation(step);
    },
  );
});
