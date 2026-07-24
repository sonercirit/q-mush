import { describe, expect, test } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../../shared/agent-loop.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import type { AgentModelDiscoverer } from "../../sync-engine/agent-model-discovery.ts";
import { executeSessionRealtimeCommand } from "../../sync-engine/session-realtime-commands.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import { TEST_USER } from "./authenticated-integration-test-helpers.ts";
import { userRealtimeCommand } from "./realtime-command-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createSessionInput,
  CREDENTIAL_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

class FailingModel implements AgentModel {
  complete(): Promise<AgentModelTurn> {
    return Promise.reject(new Error("Provider unavailable"));
  }
}

class BlockingModel implements AgentModel {
  aborted = false;
  started = false;

  complete(
    _messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ): Promise<AgentModelTurn> {
    this.started = true;
    return new Promise((_resolve, reject) => {
      const stop = (): void => {
        this.aborted = true;
        reject(new DOMException("Stopped", "AbortError"));
      };
      if (signal?.aborted === true) {
        stop();
      } else {
        signal?.addEventListener("abort", stop, { once: true });
      }
    });
  }
}

async function execute(
  setup: ReturnType<typeof connectedSessionSetup>,
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return executeSessionRealtimeCommand(
    setup.sessions,
    TEST_USER,
    userRealtimeCommand(operation, payload),
  );
}

async function createSession(
  setup: ReturnType<typeof connectedSessionSetup>,
  input = createSessionInput(),
): Promise<unknown> {
  return execute(setup, SESSION_REALTIME_OPERATIONS.create, input);
}

async function startAndComplete(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<unknown> {
  await createSession(setup);
  await completeAgentFileLookup(setup);
  return waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus("idle"),
  );
}

function unavailableCreateInput(
  field: "credentialId" | "runnerId",
  value: string,
): Readonly<Record<string, unknown>> {
  return { ...createSessionInput(), [field]: value };
}

describe("session realtime integration", () => {
  test("persists create images and model failures through realtime commands", async () => {
    const imageModel = new ScriptedAgentModel([
      { content: "Screenshot implemented.", toolCalls: [] },
    ]);
    const imageSetup = connectedSessionSetup(imageModel);
    await createSession(
      imageSetup,
      createSessionInput(true, "high", "gpt-4.1-mini", [TEST_AGENT_IMAGE]),
    );
    await completeAgentFileLookup(imageSetup);
    const completed = await waitForSessionValue(
      () => sessionDetail(imageSetup.sessions),
      hasSessionStatus("idle"),
    );
    expect(completed).toMatchObject({
      messages: [
        { images: [TEST_AGENT_IMAGE], role: "user" },
        { role: "assistant" },
      ],
    });
    expect(imageModel.requests[0]?.[0]).toEqual({
      content: "Inspect README.md",
      images: [TEST_AGENT_IMAGE],
      role: "user",
    });
    imageSetup.database.$client.close();

    const failureSetup = connectedSessionSetup(new FailingModel());
    await createSession(failureSetup);
    await completeAgentFileLookup(failureSetup);
    const failed = await waitForSessionValue(
      () => sessionDetail(failureSetup.sessions),
      hasSessionStatus("failed"),
    );
    expect(failed).toMatchObject({
      messages: [
        { role: "user" },
        { content: "Session failed: Provider unavailable", role: "error" },
      ],
    });
    failureSetup.database.$client.close();
  });

  test("discovers models and applies discovered metadata on create", async () => {
    const catalog: AgentModelCatalog = {
      defaultModel: "gpt-discovered",
      models: [
        {
          contextWindow: 200_000,
          id: "gpt-discovered",
          inputModalities: null,
          label: "GPT Discovered",
          outputModalities: null,
          pricing: {
            cachedInput: "0.0000001",
            input: "0.0000004",
            output: "0.0000016",
          },
          reasoningEfforts: ["low", "high"],
        },
      ],
    };
    const discoverModels: AgentModelDiscoverer = (provider, credential) => {
      expect(provider).toBe("openai");
      expect(credential.secret).toBe("provider-secret");
      return Promise.resolve(catalog);
    };
    const setup = connectedSessionSetup(
      new ScriptedAgentModel([
        { content: "Discovered model complete.", toolCalls: [] },
      ]),
      "api_key",
      discoverModels,
    );

    await expect(
      execute(setup, SESSION_REALTIME_OPERATIONS.models, {
        credentialId: CREDENTIAL_ID,
        provider: "openai",
      }),
    ).resolves.toEqual(catalog);
    const created = await execute(
      setup,
      SESSION_REALTIME_OPERATIONS.create,
      createSessionInput(true, "high", "gpt-discovered"),
    );
    expect(created).toMatchObject({
      autoCompact: true,
      maxContextTokens: 200_000,
      providerPricing: catalog.models[0]?.pricing,
    });
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    expect(setup.selectedPricing).toEqual([catalog.models[0]?.pricing]);
    setup.database.$client.close();
  });

  test("changes compaction mode and manually compacts an idle session", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "Initial work complete.",
        contextTokens: 90_000,
        toolCalls: [],
      },
      {
        content: "Concise handoff.",
        tokenUsage: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 1_000,
          inputTokens: 2_000,
          outputTokens: 500,
        },
        toolCalls: [],
      },
    ]);
    const setup = connectedSessionSetup(model, "api_key", () =>
      Promise.resolve({
        defaultModel: "gpt-4.1-mini",
        models: [
          {
            contextWindow: null,
            id: "gpt-4.1-mini",
            inputModalities: null,
            label: "GPT",
            outputModalities: null,
            pricing: null,
            reasoningEfforts: [],
          },
        ],
      }),
    );
    await startAndComplete(setup);

    await expect(
      execute(setup, SESSION_REALTIME_OPERATIONS.setAutoCompaction, {
        autoCompact: false,
        sessionId: SESSION_ID,
      }),
    ).resolves.toMatchObject({ autoCompact: false });
    await expect(
      execute(setup, SESSION_REALTIME_OPERATIONS.compact, {
        sessionId: SESSION_ID,
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await completeAgentFileLookup(setup);
    const compacted = await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      (value) =>
        hasSessionStatus("idle")(value) &&
        JSON.stringify(value).includes("Concise handoff."),
    );
    expect(JSON.stringify(compacted)).not.toContain("Initial work complete.");
    expect(compacted).toMatchObject({
      costBasis: "estimated",
      costUsd: 0.0013,
      currentContextTokens: 0,
    });
    setup.database.$client.close();
  });

  test("stops a running model request", async () => {
    const model = new BlockingModel();
    const setup = connectedSessionSetup(model);
    await createSession(setup);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.started,
      (value) => value === true,
    );

    await expect(
      execute(setup, SESSION_REALTIME_OPERATIONS.stop, {
        sessionId: SESSION_ID,
      }),
    ).resolves.toMatchObject({ status: "stopped" });
    await waitForSessionValue(
      () => model.aborted,
      (value) => value === true,
    );
    expect(model.started).toBe(true);
    const summaries = setup.sessions.summariesForUser(TEST_USER.id);
    setup.database.$client.close();
    expect(summaries.at(0)?.id).toBe(SESSION_ID);
  });

  test("returns stable runner, credential, busy, and request errors", async () => {
    const setup = connectedSessionSetup(new ScriptedAgentModel([]));
    await expect(
      execute(
        setup,
        SESSION_REALTIME_OPERATIONS.create,
        unavailableCreateInput("runnerId", "missing-runner"),
      ),
    ).rejects.toMatchObject({ code: "runner_unavailable" });
    await expect(
      execute(
        setup,
        SESSION_REALTIME_OPERATIONS.create,
        unavailableCreateInput("credentialId", "missing-credential"),
      ),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
    await expect(
      execute(setup, SESSION_REALTIME_OPERATIONS.create, {
        ...createSessionInput(),
        reasoningEffort: "maximum",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await createSession(setup);
    await expect(
      execute(setup, SESSION_REALTIME_OPERATIONS.send, {
        prompt: "Too soon",
        sessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ code: "session_busy" });
    await execute(setup, SESSION_REALTIME_OPERATIONS.stop, {
      sessionId: SESSION_ID,
    });
    setup.database.$client.close();
  });
});
