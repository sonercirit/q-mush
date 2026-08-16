import { describe, expect, test } from "vitest";
import type { AgentModelStep } from "../../shared/agent-loop.ts";
import { createAgentSystemPrompt } from "../../shared/agent-prompt.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import {
  createProviderStreamAccumulator,
  type ProviderTextDelta,
} from "../../sync-engine/provider-stream.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  createFallbackModel,
  createSessionAgentModels,
  type AgentModelFactory,
} from "../../sync-engine/session-agent-models.ts";
import { TEST_COMPACTION_REQUEST_MESSAGE } from "./compaction-test-fixtures.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { RecordingRealtimeSocket } from "./realtime-hub-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { promiseGate } from "./session-race-test-helpers.ts";

const CREDENTIAL: ProviderCredentialAccess = {
  accountId: null,
  id: "credential-1",
  isDefault: false,
  label: "OpenRouter",
  secret: "provider-secret",
  source: "api_key",
};

function recordingFactory(
  selections: Parameters<AgentModelFactory>[0][],
): AgentModelFactory {
  return (options) => {
    selections.push(options);
    return new ScriptedAgentModel([]);
  };
}

function modelSelections(): {
  readonly factory: AgentModelFactory;
  readonly selections: Parameters<AgentModelFactory>[0][];
} {
  const selections: Parameters<AgentModelFactory>[0][] = [];
  return { factory: recordingFactory(selections), selections };
}

function connectedRealtime(
  hub: RealtimeHub,
  socket: RecordingRealtimeSocket,
): void {
  hub.setUser("user-1", socket, true, TEST_SESSION_DETAIL.workspaceId);
}

function realtimeSetup(): {
  readonly hub: RealtimeHub;
  readonly socket: RecordingRealtimeSocket;
} {
  const hub = new RealtimeHub();
  const socket = new RecordingRealtimeSocket();
  connectedRealtime(hub, socket);
  return { hub, socket };
}

function compactionRequest(streamId: string) {
  return {
    content: TEST_COMPACTION_REQUEST_MESSAGE,
    sessionId: TEST_SESSION_DETAIL.id,
    streamId,
    type: "session_compaction_request" as const,
  };
}

function compactionSettled() {
  return {
    sessionId: TEST_SESSION_DETAIL.id,
    type: "session_compaction_settled" as const,
  };
}

function sessionDelta(content: string, thinking: string, streamId: string) {
  return {
    content,
    sessionId: TEST_SESSION_DETAIL.id,
    streamId,
    thinking,
    type: "session_delta" as const,
  };
}

function expectRealtimeDeltas(
  socket: RecordingRealtimeSocket,
  expected: readonly unknown[],
): void {
  expect(
    socket.messages.map((message): unknown => JSON.parse(message)),
  ).toEqual(expected);
}

function sessionModelOptions(
  factory: AgentModelFactory,
  overrides: Partial<Parameters<typeof createSessionAgentModels>[0]> = {},
): Parameters<typeof createSessionAgentModels>[0] {
  return {
    agentFile: null,
    credential: CREDENTIAL,
    detail: TEST_SESSION_DETAIL,
    factory,
    id: () => "stream-id",
    isCurrent: () => true,
    realtime: undefined,
    userId: "user-1",
    ...overrides,
  };
}

describe("session agent models", () => {
  test("notifies the step-start hook when a model step begins", () => {
    const { factory, selections } = modelSelections();
    const stepStarts: number[] = [];

    const models = createSessionAgentModels(
      sessionModelOptions(factory, {
        onStepStart: () => stepStarts.push(Date.now()),
      }),
    );
    selections[0]?.onStepStart?.();
    selections[0]?.onStepStart?.();

    expect(stepStarts).toHaveLength(2);
    expect(models.agent).toBeDefined();

    // The compactor's model step restarts the same persisted step clock.
    models.createCompactor();
    selections[1]?.onStepStart?.();

    expect(stepStarts).toHaveLength(3);
  });

  test("keys request capabilities and catalog output limit to the session", () => {
    const { factory, selections } = modelSelections();

    createSessionAgentModels(
      sessionModelOptions(factory, {
        detail: {
          ...TEST_SESSION_DETAIL,
          adaptiveThinking: false,
          maxOutputTokens: 64_000,
        },
      }),
    );

    // Anthropic-format Messages requests require max_tokens; the persisted
    // catalog metadata must reach every session model construction.
    expect(selections[0]).toMatchObject({
      adaptiveThinking: false,
      maxOutputTokens: 64_000,
      promptCacheKey: TEST_SESSION_DETAIL.id,
    });
  });

  test("passes a global fallback routing selection to the agent model", () => {
    const { factory, selections } = modelSelections();

    createFallbackModel(factory, {
      adaptiveThinking: null,
      credential: CREDENTIAL,
      maxOutputTokens: null,
      model: "vendor/model",
      openRouterProviderTag: "q-mush-routing:exacto",
      prompt: null,
      provider: "openrouter",
      providerPricing: null,
    });

    expect(selections[0]).toMatchObject({
      openRouterProviderRouting: { sort: "exacto", type: "sort" },
    });
  });

  test("streams provider thinking and response to the workspace socket", () => {
    const { hub, socket } = realtimeSetup();
    let onDelta: ((delta: ProviderTextDelta) => void) | undefined;
    const factory: AgentModelFactory = (options) => {
      onDelta = options.onDelta;
      return new ScriptedAgentModel([]);
    };
    createSessionAgentModels(
      sessionModelOptions(factory, {
        realtime: hub,
      }),
    );

    const accumulator = createProviderStreamAccumulator(
      "chat_completions",
      onDelta,
    );
    for (const delta of [
      { reasoning: "Checking first" },
      { content: "Answering now" },
    ]) {
      accumulator.push({ choices: [{ delta }] });
    }

    expectRealtimeDeltas(socket, [
      sessionDelta("", "Checking first", "stream-id"),
      sessionDelta("Answering now", "", "stream-id"),
    ]);
  });

  test("streams compaction summaries as a distinct model step", async () => {
    const { hub, socket } = realtimeSetup();
    const summary = promiseGate<AgentModelStep>();
    const selections: Parameters<AgentModelFactory>[0][] = [];
    const stepStarts: number[] = [];
    let nextStreamId = 0;
    const factory: AgentModelFactory = (options) => {
      selections.push(options);
      return {
        complete: () => summary.wait(),
        ...(options.onStepStart === undefined
          ? {}
          : { startStep: options.onStepStart }),
      };
    };
    const models = createSessionAgentModels(
      sessionModelOptions(factory, {
        id: () => `stream-${String((nextStreamId += 1))}`,
        onStepStart: () => stepStarts.push(stepStarts.length),
        realtime: hub,
      }),
    );

    const conversation = [
      { content: "Conversation to compact", role: "user" as const },
    ];
    const compaction = models.createCompactor().compact(conversation);
    await summary.entered;
    const compactorOptions = selections.at(-1);
    compactorOptions?.onDelta?.({ content: "Incremental ", thinking: "" });
    compactorOptions?.onDelta?.({ content: "summary", thinking: "" });

    expect(selections).toHaveLength(2);
    expect(selections.map(({ systemPrompt }) => systemPrompt)).toEqual([
      createAgentSystemPrompt(null, TEST_SESSION_DETAIL.executionEnvironment),
      createAgentSystemPrompt(null, TEST_SESSION_DETAIL.executionEnvironment),
    ]);
    const streamed = [
      compactionRequest("stream-2"),
      sessionDelta("Incremental ", "", "stream-2"),
      sessionDelta("summary", "", "stream-2"),
    ];
    expectRealtimeDeltas(socket, streamed);
    summary.release(providerStep("Incremental summary"));
    await compaction;
    models.publishCompactionSettled();
    expectRealtimeDeltas(socket, [...streamed, compactionSettled()]);
    // The compactor model carries the persistence hook (fired once above),
    // not the stream rotation: the deltas stayed on stream-2 throughout.
    expect(stepStarts).toEqual([0]);
    expect(nextStreamId).toBe(2);
  });

  test("does not publish settlement before compaction persistence", async () => {
    const { hub, socket } = realtimeSetup();
    const models = createSessionAgentModels(
      sessionModelOptions(
        () => ({
          complete: () => Promise.reject(new Error("provider failed")),
        }),
        { realtime: hub },
      ),
    );

    await expect(
      models
        .createCompactor()
        .compact([{ content: "Conversation", role: "user" }]),
    ).rejects.toThrow("provider failed");

    expectRealtimeDeltas(socket, [compactionRequest("stream-id")]);
  });

  test("passes the persisted routing selection to agent and compactor", () => {
    const { factory, selections } = modelSelections();
    const models = createSessionAgentModels(
      sessionModelOptions(factory, {
        detail: {
          ...TEST_SESSION_DETAIL,
          credentialId: CREDENTIAL.id,
          openRouterProviderTag: "google-vertex/us",
          provider: "openrouter",
        },
      }),
    );

    models.createCompactor();

    expect(selections).toMatchObject([
      {
        openRouterProviderRouting: {
          tag: "google-vertex/us",
          type: "provider",
        },
      },
      {
        openRouterProviderRouting: {
          tag: "google-vertex/us",
          type: "provider",
        },
      },
    ]);
  });
});
