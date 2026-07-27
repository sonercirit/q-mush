import { describe, expect, test } from "vitest";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import {
  createProviderStreamAccumulator,
  type ProviderTextDelta,
} from "../../sync-engine/provider-stream.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
} from "../../sync-engine/session-agent-models.ts";
import { RecordingRealtimeSocket } from "./realtime-hub-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

const CREDENTIAL: ProviderCredentialAccess = {
  accountId: null,
  id: "credential-1",
  isDefault: false,
  label: "OpenRouter",
  secret: "provider-secret",
  source: "api_key",
};

describe("session agent models", () => {
  test("streams provider thinking and response to the workspace socket", () => {
    const hub = new RealtimeHub();
    const socket = new RecordingRealtimeSocket();
    let onDelta: ((delta: ProviderTextDelta) => void) | undefined;
    const factory: AgentModelFactory = (options) => {
      onDelta = options.onDelta;
      return new ScriptedAgentModel([]);
    };
    hub.setUser("user-1", socket, true, TEST_SESSION_DETAIL.workspaceId);
    createSessionAgentModels({
      agentFile: null,
      credential: CREDENTIAL,
      detail: TEST_SESSION_DETAIL,
      factory,
      id: () => "stream-id",
      isCurrent: () => true,
      realtime: hub,
      userId: "user-1",
    });

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

    expect(
      socket.messages.map((message): unknown => JSON.parse(message)),
    ).toEqual([
      {
        content: "",
        sessionId: TEST_SESSION_DETAIL.id,
        streamId: "stream-id",
        thinking: "Checking first",
        type: "session_delta",
      },
      {
        content: "Answering now",
        sessionId: TEST_SESSION_DETAIL.id,
        streamId: "stream-id",
        thinking: "",
        type: "session_delta",
      },
    ]);
  });

  test("passes the persisted tag to both the normal agent and compactor", () => {
    const selections: { readonly openRouterProviderTag?: string }[] = [];
    const factory: AgentModelFactory = (options) => {
      selections.push(options);
      return new ScriptedAgentModel([]);
    };
    const models = createSessionAgentModels({
      agentFile: null,
      credential: CREDENTIAL,
      detail: {
        ...TEST_SESSION_DETAIL,
        credentialId: CREDENTIAL.id,
        openRouterProviderTag: "google-vertex/us",
        provider: "openrouter",
      },
      factory,
      id: () => "stream-id",
      isCurrent: () => true,
      realtime: undefined,
      userId: "user-1",
    });

    models.createCompactor();

    expect(selections).toMatchObject([
      { openRouterProviderTag: "google-vertex/us" },
      { openRouterProviderTag: "google-vertex/us" },
    ]);
  });
});
