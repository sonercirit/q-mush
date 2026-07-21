import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "../agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../agent-loop.ts";
import type { AgentModelDiscoverer } from "../agent-model-discovery.ts";
import {
  runnerDirectoriesPath,
  SESSION_MODELS_PATH,
  SESSIONS_PATH,
} from "../routes.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  CREDENTIAL_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  completeRunnerCommand,
  expectRunnerCommand,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

class BlockingModel implements AgentModel {
  aborted = false;
  started = false;

  complete(
    _messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ): Promise<AgentModelTurn> {
    this.started = true;

    return new Promise((_resolve, reject) => {
      const stop = () => {
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

async function expectJsonResponse(
  response: Response,
  status: number,
  expected: unknown,
): Promise<void> {
  const body: unknown = await response.json();
  expect(body).toEqual(expected);
  expect(response.status).toBe(status);
}

async function expectSessionReaches(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  response: Response,
  status: string,
): Promise<void> {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus(status),
  );
}

async function startSessionWithAgentFile(
  model: AgentModel,
  agentFile: unknown,
): Promise<Awaited<ReturnType<typeof connectedSessionSetup>>> {
  const setup = connectedSessionSetup(model);
  const createResponse = await setup.sessions.collection(
    createSessionRequest(),
  );

  expect(createResponse.status).toBe(201);
  await completeAgentFileLookup(setup, agentFile);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus("idle"),
  );
  return setup;
}

async function unauthenticatedSessionStatus(): Promise<number> {
  const setup = connectedSessionSetup(new ScriptedAgentModel([]));
  const response = await setup.sessions.collection(
    new Request("http://localhost/api/sessions"),
  );
  setup.database.$client.close();
  return response.status;
}

describe("agent sessions", () => {
  test("loads the workspace agent file before starting the model", async () => {
    const model = new ScriptedAgentModel([
      { content: "Instructions followed.", toolCalls: [] },
    ]);
    const setup = await startSessionWithAgentFile(model, {
      content: "Use the repository test command.",
      name: "CLAUDE.md",
    });

    expect(setup.selectedSystemPrompts).toHaveLength(1);
    expect(setup.selectedSystemPrompts[0]).toContain("CLAUDE.md");
    expect(setup.selectedSystemPrompts[0]).toContain(
      "Use the repository test command.",
    );
    expect(await sessionDetail(setup.sessions)).toMatchObject({
      agentFile: {
        content: "Use the repository test command.",
        name: "CLAUDE.md",
      },
    });
    setup.database.$client.close();
  });

  test("accepts agent instructions without a runner-result size limit", async () => {
    const model = new ScriptedAgentModel([
      { content: "Large instructions loaded.", toolCalls: [] },
    ]);
    const content = "x".repeat(600 * 1_024);
    const setup = await startSessionWithAgentFile(model, {
      content,
      name: "AGENTS.md",
    });

    expect(setup.selectedSystemPrompts[0]).toContain(content);
    setup.database.$client.close();
  });

  test("browses directories through an owned online runner", async () => {
    const setup = connectedSessionSetup(new ScriptedAgentModel([]));
    const browseResponse = setup.sessions.directories(
      createAuthenticatedRequest(
        runnerDirectoriesPath(RUNNER_ID),
        { path: "~/projects" },
        "POST",
      ),
      RUNNER_ID,
    );
    await expectRunnerCommand(
      setup,
      {
        arguments: {},
        id: RUNNER_COMMAND_ID,
        sessionId: `directory-picker:${TEST_USER_ID}`,
        tool: "list_directories",
        workingDirectory: "~/projects",
      },
      "The runner did not receive a directory command",
    );

    const listing = {
      directories: [{ name: "q-mush", path: "/home/mush/projects/q-mush" }],
      parent: "/home/mush",
      path: "/home/mush/projects",
      truncated: false,
    };
    const resultResponse = completeRunnerCommand(
      setup,
      JSON.stringify(listing),
    );

    expect(resultResponse.status).toBe(204);
    await expectJsonResponse(await browseResponse, 200, listing);
    setup.database.$client.close();
  });

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
    });
    await expectSessionReaches(setup, createResponse, "idle");
    database.$client.close();
  });

  test("updates compaction mode and manually compacts an idle session", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "Initial work complete.",
        contextTokens: 90_000,
        toolCalls: [],
      },
      { content: "Concise handoff.", toolCalls: [] },
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
            reasoningEfforts: [],
          },
        ],
      }),
    );
    const created = await setup.sessions.collection(createSessionRequest());
    await expectSessionReaches(setup, created, "idle");

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
        `http://localhost:3000${SESSIONS_PATH}/${SESSION_ID}/compaction`,
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
    const compacted = await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      (value) => {
        if (!hasSessionStatus("idle")(value)) {
          return false;
        }
        return JSON.stringify(value).includes("Concise handoff.");
      },
    );
    expect(JSON.stringify(compacted)).not.toContain("Initial work complete.");
    expect(compacted).toMatchObject({ currentContextTokens: 0 });
    setup.database.$client.close();
  });

  test("uses a Codex model by default for OpenAI OAuth", async () => {
    const model = new ScriptedAgentModel([
      { content: "OAuth session complete.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model, "oauth");
    const { database, selectedModels, sessions } = setup;
    const response = await sessions.collection(createSessionRequest(false));

    await expectSessionReaches(setup, response, "idle");
    expect(selectedModels).toEqual(["gpt-5-codex"]);
    database.$client.close();
  });

  test("rejects an unsupported reasoning effort", async () => {
    const model = new ScriptedAgentModel([]);
    const { database, sessions } = connectedSessionSetup(model);
    const response = await sessions.collection(
      createSessionRequest(true, "maximum"),
    );

    await expectJsonResponse(response, 400, { error: "invalid_request" });
    database.$client.close();
  });

  test("drains a running session before a graceful restart", async () => {
    const restartCall = {
      arguments: '{"command":"bun run dev:restart","timeout":30}',
      id: "restart-call",
      name: "bash",
    };
    const model = new ScriptedAgentModel([
      {
        content: "Requesting a development restart.",
        toolCalls: [restartCall],
      },
      { content: "Restart completed.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model);
    const { sessions } = setup;
    const created = await sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await expectRunnerCommand(
      setup,
      {
        arguments: {
          command: "bun run dev:restart",
          timeout: 30,
        },
        id: RUNNER_COMMAND_ID,
        sessionId: SESSION_ID,
        tool: "bash",
        workingDirectory: "/work/project",
      },
      "The runner did not receive the restart command",
    );

    let drained = false;
    const drain = sessions.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(1);
    expect(drained).toBeFalse();
    await expectJsonResponse(
      await sessions.collection(createSessionRequest()),
      503,
      { error: "server_restarting" },
    );

    expect(completeRunnerCommand(setup, "Restart requested.").status).toBe(204);
    await drain;
    expect(await sessionDetail(sessions)).toMatchObject({ status: "idle" });
    expect(model.requests).toHaveLength(2);
    setup.database.$client.close();
  });

  test("stops a running model request", async () => {
    const model = new BlockingModel();
    const setup = connectedSessionSetup(model);
    const { database, sessions } = setup;
    const created = await sessions.collection(createSessionRequest());
    await expectSessionReaches(setup, created, "running");

    const stopped = await sessions.stop(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/stop`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );

    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ status: "stopped" });
    await waitForSessionValue(
      () => model.aborted,
      (value) => value === true,
    );
    expect(model.started).toBeTrue();
    database.$client.close();
  });

  test("protects session endpoints", async () => {
    expect(await unauthenticatedSessionStatus()).toBe(401);
  });
});
