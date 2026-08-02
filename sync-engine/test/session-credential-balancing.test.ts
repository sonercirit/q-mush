import { describe, expect, test } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery.ts";
import type { CreateSessionInput } from "../session-input.ts";
import {
  TEST_AUTHENTICATED_USER,
  TEST_WORKSPACE_ID,
  createTestProviderCredential,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  CREDENTIAL_ID,
  RUNNER_ID,
  connectedSessionSetup,
} from "./session-integration-fixtures.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000093";
const TEST_CATALOG = {
  defaultModel: "gpt-4.1-mini",
  models: [
    {
      contextWindow: 128_000,
      id: "gpt-4.1-mini",
      inputModalities: ["text"],
      label: "GPT 4.1 mini",
      outputModalities: ["text"],
      pricing: null,
      reasoningEfforts: [],
    },
  ],
} as const;
const IDLE_MODEL: AgentModel = {
  complete: () => Promise.resolve(providerStep("Done")),
};

function input(credentialId: string): CreateSessionInput {
  return {
    agentFilePath: null,
    autoCompact: true,
    credentialId,
    executionEnvironment: "bare_metal",
    images: [],
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

function setup(discoverModels: Parameters<typeof connectedSessionSetup>[2]) {
  let command = 0;
  return connectedSessionSetup(IDLE_MODEL, "api_key", discoverModels, {
    commandId: () => `balanced-command-${String((command += 1))}`,
    credentials: {
      openai: [
        createTestProviderCredential(CREDENTIAL_ID),
        createTestProviderCredential(SECOND_CREDENTIAL_ID),
      ],
    },
  });
}

describe("session credential balancing", () => {
  test("distributes four sessions evenly and persists each resolved credential", async () => {
    const sessions = setup(() => Promise.resolve(TEST_CATALOG));
    const selected: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      const detail = await sessions.sessions.realtimeCommands.createForUser(
        TEST_AUTHENTICATED_USER,
        input(balancedCredentialId("openai")),
        TEST_WORKSPACE_ID,
      );
      selected.push(detail.credentialId);
      expect(
        sessions.sessions.detailForUser(TEST_AUTHENTICATED_USER.id, detail.id)
          ?.credentialId,
      ).toBe(detail.credentialId);
    }

    expect(selected).toEqual([
      CREDENTIAL_ID,
      SECOND_CREDENTIAL_ID,
      CREDENTIAL_ID,
      SECOND_CREDENTIAL_ID,
    ]);
    closeSessionTestDatabase(sessions.database);
  });

  test("falls through an immediately rejected member but leaves explicit selection untouched", async () => {
    const discovered: string[] = [];
    const sessions = setup((_provider, credential) => {
      discovered.push(credential.id);
      return credential.id === CREDENTIAL_ID
        ? Promise.reject(new AgentModelDiscoveryError("rejected", 429))
        : Promise.resolve(TEST_CATALOG);
    });

    const balanced = await sessions.sessions.realtimeCommands.createForUser(
      TEST_AUTHENTICATED_USER,
      input(balancedCredentialId("openai")),
      TEST_WORKSPACE_ID,
    );
    expect(balanced.credentialId).toBe(SECOND_CREDENTIAL_ID);
    expect(discovered).toEqual([CREDENTIAL_ID, SECOND_CREDENTIAL_ID]);

    const explicit = await sessions.sessions.realtimeCommands.createForUser(
      TEST_AUTHENTICATED_USER,
      input(CREDENTIAL_ID),
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
