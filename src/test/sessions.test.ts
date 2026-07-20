import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "../agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../agent-loop.ts";
import type { AgentModelDiscoverer } from "../agent-model-discovery.ts";
import {
  RUNNER_WORK_PATH,
  runnerDirectoriesPath,
  SESSION_MODELS_PATH,
  SESSIONS_PATH,
} from "../routes.ts";
import type { createSessionIntegration } from "../sessions.ts";
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
  sessions: ReturnType<typeof createSessionIntegration>,
  response: Response,
  status: string,
): Promise<void> {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(sessions);
  await waitForSessionValue(
    () => sessionDetail(sessions),
    hasSessionStatus(status),
  );
}

async function startSessionWithAgentFile(
  model: AgentModel,
  agentFile: unknown,
): Promise<Awaited<ReturnType<typeof connectedSessionSetup>>> {
  const setup = await connectedSessionSetup(model);
  const createResponse = await setup.sessions.collection(
    createSessionRequest(),
  );

  expect(createResponse.status).toBe(201);
  await completeAgentFileLookup(setup.sessions, agentFile);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus("idle"),
  );
  return setup;
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
    const { database, sessions } = await connectedSessionSetup(
      new ScriptedAgentModel([]),
    );
    const browseResponse = sessions.directories(
      createAuthenticatedRequest(
        runnerDirectoriesPath(RUNNER_ID),
        { path: "~/projects" },
        "POST",
      ),
      RUNNER_ID,
    );
    await expectRunnerCommand(
      sessions,
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
    const resultResponse = await completeRunnerCommand(
      sessions,
      JSON.stringify(listing),
    );

    expect(resultResponse.status).toBe(204);
    await expectJsonResponse(await browseResponse, 200, listing);
    database.$client.close();
  });

  test("discovers models through an owned provider credential", async () => {
    const catalog: AgentModelCatalog = {
      defaultModel: "gpt-discovered",
      models: [
        {
          contextWindow: 200_000,
          id: "gpt-discovered",
          label: "GPT Discovered",
          reasoningEfforts: ["low", "high"],
        },
      ],
    };
    const discoverModels: AgentModelDiscoverer = (provider, credential) => {
      expect(provider).toBe("openai");
      expect(credential.secret).toBe("provider-secret");
      return Promise.resolve(catalog);
    };
    const { database, sessions } = await connectedSessionSetup(
      new ScriptedAgentModel([
        { content: "Discovered model complete.", toolCalls: [] },
      ]),
      "api_key",
      discoverModels,
    );
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
      maxContextTokens: 200_000,
    });
    await expectSessionReaches(sessions, createResponse, "idle");
    database.$client.close();
  });

  test("uses a Codex model by default for OpenAI OAuth", async () => {
    const model = new ScriptedAgentModel([
      { content: "OAuth session complete.", toolCalls: [] },
    ]);
    const { database, selectedModels, sessions } = await connectedSessionSetup(
      model,
      "oauth",
    );
    const response = await sessions.collection(createSessionRequest(false));

    await expectSessionReaches(sessions, response, "idle");
    expect(selectedModels).toEqual(["gpt-5-codex"]);
    database.$client.close();
  });

  test("rejects an unsupported reasoning effort", async () => {
    const model = new ScriptedAgentModel([]);
    const { database, sessions } = await connectedSessionSetup(model);
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
    const setup = await connectedSessionSetup(model);
    const { sessions } = setup;
    const created = await sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(sessions);
    await expectRunnerCommand(
      sessions,
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

    expect(
      (await completeRunnerCommand(sessions, "Restart requested.")).status,
    ).toBe(204);
    await drain;
    expect(await sessionDetail(sessions)).toMatchObject({ status: "idle" });
    expect(model.requests).toHaveLength(2);
    setup.database.$client.close();
  });

  test("stops a running model request", async () => {
    const model = new BlockingModel();
    const { database, sessions } = await connectedSessionSetup(model);
    const created = await sessions.collection(createSessionRequest());
    await expectSessionReaches(sessions, created, "running");

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

  test("protects session and runner-control endpoints", async () => {
    const setup = await connectedSessionSetup(new ScriptedAgentModel([]));
    const { database, sessions } = setup;

    expect(
      (await sessions.collection(new Request("http://localhost/api/sessions")))
        .status,
    ).toBe(401);
    expect(
      sessions.work(
        new Request(`http://localhost${RUNNER_WORK_PATH}`, { method: "POST" }),
      ).status,
    ).toBe(401);
    expect(
      (
        await sessions.workResult(
          new Request(`http://localhost${RUNNER_WORK_PATH}/missing`, {
            method: "POST",
          }),
          "missing",
        )
      ).status,
    ).toBe(401);
    database.$client.close();
  });
});
