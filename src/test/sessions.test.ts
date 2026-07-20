import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "../agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../agent-loop.ts";
import type { AgentModelDiscoverer } from "../agent-model-discovery.ts";
import { isRecord } from "../auth-model.ts";
import { createGoogleAuthFromEnvironment } from "../auth.ts";
import type { ProviderCredentialAccess } from "../provider-credential-store.ts";
import {
  RUNNER_REGISTER_PATH,
  RUNNER_WORK_PATH,
  SESSION_MODELS_PATH,
  SESSIONS_PATH,
} from "../routes.ts";
import { RunnerCommandBroker } from "../runner-command-broker.ts";
import { createRunnerIntegration } from "../runners.ts";
import { createSessionIntegration } from "../sessions.ts";
import {
  addTestProviderCredential,
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  createRunnerRequest,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000061";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000062";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000063";
const RUNNER_TOKEN = "qmr_session-runner-token";

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

async function waitFor(
  readValue: () => unknown,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await Promise.resolve(readValue());

    if (predicate(value)) {
      return value;
    }

    await Bun.sleep(1);
  }

  throw new Error("The session test timed out");
}

function hasStatus(expected: string): (value: unknown) => boolean {
  return (value) => isRecord(value) && value["status"] === expected;
}

async function connectedSetup(
  model: AgentModel,
  credentialSource: ProviderCredentialAccess["source"] = "api_key",
  discoverModels?: AgentModelDiscoverer,
) {
  const database = createAuthenticatedTestDatabase();
  const auth = createGoogleAuthFromEnvironment(
    {},
    {
      database,
      now: () => TEST_NOW,
    },
  );
  const runners = createRunnerIntegration(auth, {
    database,
    now: () => TEST_NOW,
    randomId: () => RUNNER_ID,
    randomToken: () => "session-runner-token",
  });
  runners.collection(
    createAuthenticatedRequest("/api/runners", undefined, "POST"),
  );
  const registration = await runners.register(
    createRunnerRequest(RUNNER_REGISTER_PATH, RUNNER_TOKEN, {
      architecture: "x64",
      machineId: "session-test-machine",
      name: "workstation",
      platform: "linux",
    }),
  );

  if (registration.status !== 201) {
    throw new Error("The session test runner did not register");
  }

  addTestProviderCredential(database, CREDENTIAL_ID);
  const credential: ProviderCredentialAccess = {
    accountId: "provider-account",
    id: CREDENTIAL_ID,
    label: "Agent key",
    secret: "provider-secret",
    source: credentialSource,
  };
  const reader = {
    readCredential: (userId: string, credentialId: string) =>
      userId === TEST_USER_ID && credentialId === CREDENTIAL_ID
        ? credential
        : undefined,
  };
  const ids = [
    SESSION_ID,
    "018bcfe5-6800-7000-8000-000000000064",
    "018bcfe5-6800-7000-8000-000000000065",
    "018bcfe5-6800-7000-8000-000000000066",
    "018bcfe5-6800-7000-8000-000000000067",
    "018bcfe5-6800-7000-8000-000000000068",
    "018bcfe5-6800-7000-8000-000000000069",
    "018bcfe5-6800-7000-8000-000000000070",
  ];
  const selectedModels: string[] = [];
  const selectedReasoningEfforts: (string | null)[] = [];
  const sessions = createSessionIntegration(
    auth,
    runners,
    { openai: reader, openrouter: reader },
    {
      broker: new RunnerCommandBroker({
        commandId: () => "agent-command-1",
        timeoutMilliseconds: 5_000,
      }),
      database,
      ...(discoverModels === undefined ? {} : { discoverModels }),
      modelFactory: ({
        credential: selectedCredential,
        model: selectedModel,
        reasoningEffort,
      }) => {
        expect(selectedCredential.secret).toBe("provider-secret");
        selectedModels.push(selectedModel);
        selectedReasoningEfforts.push(reasoningEffort);
        return model;
      },
      now: () => TEST_NOW,
      randomId: () => takeValue(ids, "The session test ran out of IDs"),
    },
  );
  return { database, selectedModels, selectedReasoningEfforts, sessions };
}

function createSessionRequest(
  includeModel = true,
  reasoningEffort = "high",
): Request {
  return createAuthenticatedRequest(
    SESSIONS_PATH,
    {
      credentialId: CREDENTIAL_ID,
      ...(includeModel ? { model: "gpt-4.1-mini" } : {}),
      prompt: "Inspect README.md",
      provider: "openai",
      reasoningEffort,
      runnerId: RUNNER_ID,
      workingDirectory: "/work/project",
    },
    "POST",
  );
}

async function commandActivity(
  sessions: ReturnType<typeof createSessionIntegration>,
  path: string,
): Promise<unknown> {
  const response = await sessions.workResult(
    createRunnerRequest(path, RUNNER_TOKEN, undefined, "GET"),
    "agent-command-1",
  );
  return response.json();
}

async function expectSessionReaches(
  sessions: ReturnType<typeof createSessionIntegration>,
  response: Response,
  status: string,
): Promise<void> {
  expect(response.status).toBe(201);
  await waitFor(() => sessionDetail(sessions), hasStatus(status));
}

async function sessionDetail(
  sessions: ReturnType<typeof createSessionIntegration>,
): Promise<unknown> {
  const response = sessions.item(
    createAuthenticatedRequest(`${SESSIONS_PATH}/${SESSION_ID}`),
    SESSION_ID,
  );
  return response.json();
}

describe("agent sessions", () => {
  test("spawns a session, executes tools on its runner, and accepts follow-ups", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "Reading the file.",
        toolCalls: [
          {
            arguments: '{"path":"README.md"}',
            id: "model-tool-1",
            name: "read_file",
          },
        ],
      },
      { content: "README inspected.", toolCalls: [] },
      { content: "Follow-up complete.", toolCalls: [] },
    ]);
    const { database, selectedReasoningEfforts, sessions } =
      await connectedSetup(model);
    const createResponse = await sessions.collection(createSessionRequest());

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({
      id: SESSION_ID,
      reasoningEffort: "high",
      status: "queued",
      title: "Inspect README.md",
    });

    const workResponse = await waitFor(
      () => sessions.work(createRunnerRequest(RUNNER_WORK_PATH, RUNNER_TOKEN)),
      (value) => value instanceof Response && value.status === 200,
    );

    if (!(workResponse instanceof Response)) {
      throw new Error("The runner did not receive a response");
    }

    const command: unknown = await workResponse.json();
    expect(command).toEqual({
      command: {
        arguments: { path: "README.md" },
        id: "agent-command-1",
        sessionId: SESSION_ID,
        tool: "read_file",
        workingDirectory: "/work/project",
      },
    });
    expect(JSON.stringify(command)).not.toContain("provider-secret");
    const commandPath = `${RUNNER_WORK_PATH}/agent-command-1`;
    expect(await commandActivity(sessions, commandPath)).toEqual({
      active: true,
    });

    const resultResponse = await sessions.workResult(
      createRunnerRequest(commandPath, RUNNER_TOKEN, {
        output: "# Q Mush",
      }),
      "agent-command-1",
    );
    expect(resultResponse.status).toBe(204);
    expect(await commandActivity(sessions, commandPath)).toEqual({
      active: false,
    });
    const idle = await waitFor(
      () => sessionDetail(sessions),
      hasStatus("idle"),
    );
    expect(JSON.stringify(idle)).toContain("README inspected.");
    expect(JSON.stringify(idle)).toContain("# Q Mush");

    const followUp = await sessions.message(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/messages`,
        { prompt: "Now summarize it" },
        "POST",
      ),
      SESSION_ID,
    );
    expect(followUp.status).toBe(202);
    const continued = await waitFor(
      () => sessionDetail(sessions),
      (value) =>
        hasStatus("idle")(value) &&
        JSON.stringify(value).includes("Follow-up complete."),
    );
    expect(JSON.stringify(continued)).toContain("Now summarize it");
    expect(model.requests).toHaveLength(3);
    expect(selectedReasoningEfforts).toEqual(["high", "high"]);
    database.$client.close();
  });

  test("discovers models through an owned provider credential", async () => {
    const catalog: AgentModelCatalog = {
      defaultModel: "gpt-discovered",
      models: [
        {
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
    const { database, sessions } = await connectedSetup(
      new ScriptedAgentModel([]),
      "api_key",
      discoverModels,
    );
    const response = await sessions.models(
      createAuthenticatedRequest(
        `${SESSION_MODELS_PATH}?provider=openai&credentialId=${CREDENTIAL_ID}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    database.$client.close();
  });

  test("uses a Codex model by default for OpenAI OAuth", async () => {
    const model = new ScriptedAgentModel([
      { content: "OAuth session complete.", toolCalls: [] },
    ]);
    const { database, selectedModels, sessions } = await connectedSetup(
      model,
      "oauth",
    );
    const response = await sessions.collection(createSessionRequest(false));

    await expectSessionReaches(sessions, response, "idle");
    expect(selectedModels).toEqual(["gpt-5-codex"]);
    database.$client.close();
  });

  test("rejects an unsupported reasoning effort", async () => {
    const { database, sessions } = await connectedSetup(
      new ScriptedAgentModel([]),
    );
    const response = await sessions.collection(
      createSessionRequest(true, "maximum"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    database.$client.close();
  });

  test("stops a running model request", async () => {
    const model = new BlockingModel();
    const { database, sessions } = await connectedSetup(model);
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
    await waitFor(
      () => model.aborted,
      (value) => value === true,
    );
    expect(model.started).toBeTrue();
    database.$client.close();
  });

  test("protects session and runner-control endpoints", async () => {
    const model = new ScriptedAgentModel([]);
    const { database, sessions } = await connectedSetup(model);

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
