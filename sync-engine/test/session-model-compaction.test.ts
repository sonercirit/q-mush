import { describe, expect, test } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { SESSION_MODELS_PATH, SESSIONS_PATH } from "../../shared/routes.ts";
import type { AgentModelDiscoverer } from "../../sync-engine/agent-model-discovery.ts";
import {
  createAuthenticatedRequest,
  TEST_AUTHENTICATED_USER,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { testModelCatalog } from "./session-continuation-test-helpers.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  CREDENTIAL_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  expectSessionReaches,
  hasSessionStatus,
  sessionDetail,
  startSessionAndCompleteAgentFile,
  waitForSessionStatus,
} from "./session-integration-helpers.ts";
import {
  closeSessionTestDatabase,
  expectJsonResponse,
} from "./session-launch-race-helpers.ts";

function compactionSetup(model: ScriptedAgentModel, label: string) {
  return connectedSessionSetup(model, "api_key", () =>
    Promise.resolve(testModelCatalog("gpt-4.1-mini", label)),
  );
}

async function waitForIdleContent(
  setup: ReturnType<typeof connectedSessionSetup>,
  content: string,
): Promise<unknown> {
  let current: unknown;
  while (
    !hasSessionStatus("idle")(current) ||
    !JSON.stringify(current).includes(content)
  ) {
    current = await sessionDetail(setup.sessions);
    if (!hasSessionStatus("idle")(current)) {
      await Bun.sleep(1);
    }
  }
  return current;
}

describe("session models and compaction", () => {
  test("discovers models through an owned provider credential", async () => {
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
    const { database, sessions } = setup;
    const response = await sessions.models(
      createAuthenticatedRequest(
        `${SESSION_MODELS_PATH}?provider=openai&credentialId=${CREDENTIAL_ID}`,
      ),
    );

    await expectJsonResponse(response, 200, catalog);

    const createResponse = await sessions.collection(
      createSessionRequest(true, "high", "gpt-discovered"),
    );
    expect(await createResponse.json()).toMatchObject({
      autoCompact: true,
      maxContextTokens: 200_000,
      providerPricing: catalog.models[0]?.pricing,
    });
    await expectSessionReaches(setup, createResponse, "idle");
    expect(setup.selectedPricing).toEqual([catalog.models[0]?.pricing]);
    database.$client.close();
  });

  test("updates compaction mode and manually compacts an idle session", async () => {
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
    const setup = compactionSetup(model, "GPT");
    await startSessionAndCompleteAgentFile(setup);
    await waitForSessionStatus(setup, "idle");

    const modeResponse = await setup.sessions.compaction(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/compaction`,
        { autoCompact: "false" },
        "POST",
      ),
      SESSION_ID,
    );
    expect(modeResponse.status).toBe(400);
    const validModeResponse = await setup.sessions.compaction(
      new Request(
        `http://localhost:3000${SESSIONS_PATH}/${SESSION_ID}/compaction?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
        {
          body: JSON.stringify({ autoCompact: false }),
          headers: {
            "content-type": "application/json",
            cookie: "q_mush_session=authenticated-session",
          },
          method: "POST",
        },
      ),
      SESSION_ID,
    );
    expect(validModeResponse.status).toBe(200);
    expect(await validModeResponse.json()).toMatchObject({
      autoCompact: false,
    });

    const compactResponse = await setup.sessions.compact(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/compact`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(compactResponse.status).toBe(202);
    await completeAgentFileLookup(setup);
    const compacted = await waitForIdleContent(setup, "Concise handoff.");
    expect(JSON.stringify(compacted)).not.toContain("Initial work complete.");
    expect(compacted).toMatchObject({
      costBasis: "estimated",
      costUsd: 0.0013,
      currentContextTokens: 0,
    });

    closeSessionTestDatabase(setup.database);
  });

  test("compacts and continues without appending a user message", async () => {
    const model = new ScriptedAgentModel([
      { content: "Initial work complete.", toolCalls: [] },
      { content: "Compact continuation handoff.", toolCalls: [] },
      { content: "Continued work complete.", toolCalls: [] },
    ]);
    const setup = compactionSetup(model, "Compact continuation");
    await startSessionAndCompleteAgentFile(setup);
    await waitForSessionStatus(setup, "idle");
    const before = await sessionDetail(setup.sessions);

    const queued =
      await setup.sessions.realtimeCommands.compactAndContinueForUser(
        TEST_AUTHENTICATED_USER,
        SESSION_ID,
        TEST_WORKSPACE_ID,
      );
    expect(["queued", "running"]).toContain(queued.status);
    await expect(
      setup.sessions.realtimeCommands.compactAndContinueForUser(
        TEST_AUTHENTICATED_USER,
        SESSION_ID,
        TEST_WORKSPACE_ID,
      ),
    ).rejects.toMatchObject({ code: "session_busy" });
    await completeAgentFileLookup(setup);
    await completeAgentFileLookup(setup);
    const continued = await waitForIdleContent(
      setup,
      "Continued work complete.",
    );

    expect(model.requests).toHaveLength(3);
    expect(model.requests.at(-1)?.at(0)?.content).toContain(
      "Compact continuation handoff.",
    );
    const continuedText = JSON.stringify(continued);
    expect(continuedText).toContain("Compact continuation handoff.");
    expect(continuedText).not.toContain("Initial work complete.");
    const userRole = '"role":"user"';
    expect(continuedText.split(userRole)).toHaveLength(
      JSON.stringify(before).split(userRole).length,
    );
    closeSessionTestDatabase(setup.database);
  });
});
