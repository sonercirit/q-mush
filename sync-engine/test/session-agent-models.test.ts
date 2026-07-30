import { describe, expect, test } from "vitest";
import type { AgentModelTurn } from "../../shared/agent-loop.ts";
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
import { providerTurn } from "./provider-turn-fixtures.ts";
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
  test("passes a global fallback routing selection to the agent model", () => {
    const { factory, selections } = modelSelections();

    createFallbackModel(factory, {
      credential: CREDENTIAL,
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

  test("streams compaction summaries as a distinct model turn", async () => {
    const { hub, socket } = realtimeSetup();
    const summary = promiseGate<AgentModelTurn>();
    const selections: Parameters<AgentModelFactory>[0][] = [];
    let nextStreamId = 0;
    const factory: AgentModelFactory = (options) => {
      selections.push(options);
      return { complete: () => summary.wait() };
    };
    const models = createSessionAgentModels(
      sessionModelOptions(factory, {
        id: () => `stream-${String((nextStreamId += 1))}`,
        realtime: hub,
      }),
    );

    const compaction = models
      .createCompactor()
      .compact([{ content: "Conversation to compact", role: "user" }]);
    await summary.entered;
    const compactorOptions = selections.at(-1);
    compactorOptions?.onDelta?.({ content: "Incremental ", thinking: "" });
    compactorOptions?.onDelta?.({ content: "summary", thinking: "" });

    expectRealtimeDeltas(socket, [
      sessionDelta("Incremental ", "", "stream-2"),
      sessionDelta("summary", "", "stream-2"),
    ]);
    summary.release(providerTurn("Incremental summary"));
    await compaction;
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
