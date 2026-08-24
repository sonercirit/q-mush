import { describe, expect, test } from "vitest";
import { createAgentRequestRecorder } from "./assistant-prefill-test-helpers.ts";
import type {
  AgentConversationMessage,
  AgentModel,
} from "../../shared/agent-loop.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery-fetch.ts";
import type { AgentModelFactory } from "../session-agent-models.ts";
import type { CreateSessionInput } from "../session-input.ts";
import {
  TEST_AUTHENTICATED_USER,
  TEST_WORKSPACE_ID,
  createTestProviderCredential,
} from "./authenticated-integration-test-helpers.ts";
import {
  balancedTestCredentialOrder,
  fourBalancedSessions,
} from "./credential-balancing-fixtures.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { toolCall } from "./session-agent-tool-setup.ts";
import {
  CREDENTIAL_ID,
  RUNNER_ID,
  connectedSessionSetup,
  testCredentialId,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000093";
const TEST_CATALOG = testAgentModelCatalog({
  id: "gpt-4.1-mini",
  label: "GPT 4.1 mini",
});
const IDLE_MODEL: AgentModel = {
  complete: () => Promise.resolve(providerStep("Done")),
};

function input(credentialId: string): CreateSessionInput {
  return {
    agentFilePath: null,
    autoCompact: true,
    images: [],
    credentialId,
    executionEnvironment: "bare_metal",
    model: "gpt-4.1-mini",
    openRouterProviderTag: null,
    prompt: "Inspect the workspace",
    provider: "openai",
    reasoningEffort: null,
    runnerId: RUNNER_ID,
    tools: AGENT_SESSION_TOOL_NAMES,
    workingDirectory: "/work/project",
  };
}

interface RestartPinnedModel {
  readonly complete: AgentModel["complete"];
  readonly entered: PromiseWithResolvers<undefined>;
  readonly release: PromiseWithResolvers<undefined>;
  readonly requests: AgentConversationMessage[][];
}
function createRestartPinnedModel(blockedRequest?: number): RestartPinnedModel {
  let blockRequest = blockedRequest;
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const recorder = createAgentRequestRecorder();
  const { requests } = recorder;
  return {
    entered,
    release,
    requests,
    complete: async (messages) => {
      const step = requests.length + 1;
      recorder.record(messages);
      if (step === blockRequest) {
        entered.resolve(undefined);
        await release.promise;
        blockRequest = undefined;
      }
      const content = `Step ${String(step)}`;
      return step === 1 || step === 3
        ? providerStep(content, {
            toolCalls: [toolCall("list_runners", {})],
          })
        : providerStep(content);
    },
  };
}

function balancedCredentials() {
  return {
    openai: [
      createTestProviderCredential(CREDENTIAL_ID),
      createTestProviderCredential(SECOND_CREDENTIAL_ID),
    ],
  };
}

function selectedCredentialFactory(
  model: AgentModel,
  selectedCredentials: string[],
): AgentModelFactory {
  return ({ credential }) => ({
    complete: (messages, signal) => {
      selectedCredentials.push(testCredentialId(credential));
      return model.complete(messages, signal);
    },
  });
}

function sessionFixture(
  discoverModels: Parameters<typeof connectedSessionSetup>[2],
) {
  let command = 0;
  return connectedSessionSetup(IDLE_MODEL, "api_key", discoverModels, {
    commandId: () => `balanced-command-${String((command += 1))}`,
    credentials: balancedCredentials(),
  });
}

function balancedCreate(setup: ReturnType<typeof sessionFixture>) {
  return setup.sessions.realtimeCommands.createForUser(
    TEST_AUTHENTICATED_USER,
    input(balancedCredentialId("openai")),
    TEST_WORKSPACE_ID,
  );
}

function expectNoSessions(setup: ReturnType<typeof sessionFixture>): void {
  expect(setup.sessions.listForUser(TEST_AUTHENTICATED_USER.id)).toEqual([]);
}

describe("session credential balancing", () => {
  test("distributes four sessions evenly and persists each resolved credential", async () => {
    const sessions = sessionFixture(() => Promise.resolve(TEST_CATALOG));
    const create: Parameters<
      typeof sessions.sessions.realtimeCommands.createForUser
    > = [
      TEST_AUTHENTICATED_USER,
      input(balancedCredentialId("openai")),
      TEST_WORKSPACE_ID,
    ];
    const selected = await fourBalancedSessions({
      commands: sessions.sessions.realtimeCommands,
      create,
      persistedCredentialId: (detail) =>
        sessions.sessions.detailForUser(TEST_AUTHENTICATED_USER.id, detail.id)
          ?.credentialId,
    });

    expect(selected).toEqual(
      balancedTestCredentialOrder(CREDENTIAL_ID, SECOND_CREDENTIAL_ID),
    );
    closeSessionTestDatabase(sessions.database);
  });

  test("pins the resolved credential across steps, continue, and restart resume", async () => {
    const selectedCredentials: string[] = [];
    const beforeRestart = createRestartPinnedModel(3);
    const initial = connectedSessionSetup(
      beforeRestart,
      "api_key",
      () => Promise.resolve(TEST_CATALOG),
      {
        credentials: balancedCredentials(),
        modelFactory: selectedCredentialFactory(
          beforeRestart,
          selectedCredentials,
        ),
      },
    );
    const createBalanced = [
      TEST_AUTHENTICATED_USER,
      input(balancedCredentialId("openai")),
      TEST_WORKSPACE_ID,
    ] as const;
    const created = await initial.sessions.realtimeCommands.createForUser(
      ...createBalanced,
    );
    await completeAgentFileLookup(initial);
    await waitForSessionValue(
      () =>
        initial.sessions.detailForUser(TEST_AUTHENTICATED_USER.id, created.id),
      hasSessionStatus("idle"),
    );
    expect(beforeRestart.requests).toHaveLength(2);
    await initial.sessions.realtimeCommands.continueForUser(
      TEST_AUTHENTICATED_USER,
      created.id,
      TEST_WORKSPACE_ID,
    );
    await completeAgentFileLookup(initial);
    await beforeRestart.entered.promise;
    const draining = initial.sessions.drain();
    beforeRestart.release.resolve(undefined);
    await draining;
    expect(
      initial.sessions.detailForUser(TEST_AUTHENTICATED_USER.id, created.id),
    ).toMatchObject({ credentialId: CREDENTIAL_ID, status: "paused" });

    const afterRestart = createRestartPinnedModel();
    const recreatedOptions = {
      credentials: balancedCredentials(),
      database: initial.database,
      modelFactory: selectedCredentialFactory(
        afterRestart,
        selectedCredentials,
      ),
    };
    const recreated = connectedSessionSetup(
      afterRestart,
      "api_key",
      () => Promise.resolve(TEST_CATALOG),
      recreatedOptions,
    );
    await completeAgentFileLookup(recreated);
    await waitForSessionValue(
      () =>
        recreated.sessions.detailForUser(
          TEST_AUTHENTICATED_USER.id,
          created.id,
        ),
      hasSessionStatus("idle"),
    );

    expect(beforeRestart.requests).toHaveLength(3);
    expect(afterRestart.requests).toHaveLength(2);
    expect(selectedCredentials).toEqual([
      CREDENTIAL_ID,
      CREDENTIAL_ID,
      CREDENTIAL_ID,
      CREDENTIAL_ID,
      CREDENTIAL_ID,
    ]);
    closeSessionTestDatabase(initial.database);
  });

  test("retries an OAuth refresh outage on the next spawn", async () => {
    let refreshAvailable = false;
    const sessions = connectedSessionSetup(
      IDLE_MODEL,
      "oauth",
      () => Promise.resolve(TEST_CATALOG),
      {
        credentials: {
          openai: [
            createTestProviderCredential(CREDENTIAL_ID, "oauth"),
            createTestProviderCredential(SECOND_CREDENTIAL_ID, "oauth"),
          ],
        },
        readCredential: (read) =>
          refreshAvailable
            ? Promise.resolve(read())
            : Promise.reject(new TypeError("refresh unavailable")),
      },
    );
    const createBalanced = () => balancedCreate(sessions);

    await expect(createBalanced()).rejects.toMatchObject({
      code: "credential_unavailable",
    });
    expectNoSessions(sessions);
    refreshAvailable = true;
    const created = await createBalanced();
    expect([CREDENTIAL_ID, SECOND_CREDENTIAL_ID]).toContain(
      created.credentialId,
    );
    closeSessionTestDatabase(sessions.database);
  });

  test("rejects a transient balanced probe without creating a session", async () => {
    const sessions = sessionFixture(() =>
      Promise.reject(new AgentModelDiscoveryError("temporary outage", 503)),
    );

    await expect(balancedCreate(sessions)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expectNoSessions(sessions);
    closeSessionTestDatabase(sessions.database);
  });

  test("falls through an immediately rejected member but leaves explicit selection untouched", async () => {
    const discovered: string[] = [];
    const sessions = sessionFixture((_provider, credential) => {
      discovered.push(credential.id);
      return credential.id === CREDENTIAL_ID
        ? Promise.reject(new AgentModelDiscoveryError("rejected", 429))
        : Promise.resolve(TEST_CATALOG);
    });

    const balancedInput = input(balancedCredentialId("openai"));
    const balanced = await sessions.sessions.realtimeCommands.createForUser(
      TEST_AUTHENTICATED_USER,
      balancedInput,
      TEST_WORKSPACE_ID,
    );
    expect(balanced.credentialId).toBe(SECOND_CREDENTIAL_ID);
    expect(discovered).toEqual([CREDENTIAL_ID, SECOND_CREDENTIAL_ID]);
    const persistedBalanced = sessions.sessions.detailForUser(
      TEST_AUTHENTICATED_USER.id,
      balanced.id,
    );
    expect(persistedBalanced).toMatchObject({
      credentialId: SECOND_CREDENTIAL_ID,
      id: balanced.id,
    });

    const explicitInput = input(CREDENTIAL_ID);
    const explicit = await sessions.sessions.realtimeCommands.createForUser(
      TEST_AUTHENTICATED_USER,
      explicitInput,
      TEST_WORKSPACE_ID,
    );
    expect(explicit.credentialId).toBe(CREDENTIAL_ID);
    expect(discovered).toEqual([
      CREDENTIAL_ID,
      SECOND_CREDENTIAL_ID,
      CREDENTIAL_ID,
    ]);
    closeSessionTestDatabase(sessions.database);
  });
});
