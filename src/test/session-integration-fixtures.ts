import { expect } from "bun:test";
import type { AgentModel } from "../agent-loop.ts";
import type { AgentModelDiscoverer } from "../agent-model-discovery.ts";
import { createGoogleAuthFromEnvironment } from "../auth.ts";
import type { ProviderCredentialAccess } from "../provider-credential-store.ts";
import {
  RUNNER_REGISTER_PATH,
  RUNNER_WORK_PATH,
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

export const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000061";
export const SESSION_ID = "018bcfe5-6800-7000-8000-000000000062";
export const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000063";
export const RUNNER_TOKEN = "qmr_session-runner-token";
export const RUNNER_COMMAND_ID = "agent-command-1";
export const RUNNER_COMMAND_PATH = `${RUNNER_WORK_PATH}/${RUNNER_COMMAND_ID}`;

export async function connectedSessionSetup(
  model: AgentModel,
  credentialSource: ProviderCredentialAccess["source"] = "api_key",
  discoverModels?: AgentModelDiscoverer,
) {
  const database = createAuthenticatedTestDatabase();
  const authOptions = { database, now: () => TEST_NOW };
  const auth = createGoogleAuthFromEnvironment({}, authOptions);
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
  const selectedSystemPrompts: string[] = [];
  const sessions = createSessionIntegration(
    auth,
    runners,
    { openai: reader, openrouter: reader },
    {
      braveSearch: {
        execute: () =>
          Promise.resolve("Error: no Brave Search API keys are available."),
      },
      broker: new RunnerCommandBroker({ commandId: () => RUNNER_COMMAND_ID }),
      database,
      ...(discoverModels === undefined ? {} : { discoverModels }),
      modelFactory: ({
        credential: selectedCredential,
        model: selectedModel,
        reasoningEffort,
        systemPrompt,
      }) => {
        expect(selectedCredential.secret).toBe("provider-secret");
        selectedModels.push(selectedModel);
        selectedReasoningEfforts.push(reasoningEffort);
        selectedSystemPrompts.push(systemPrompt);
        return model;
      },
      now: () => TEST_NOW,
      randomId: () => takeValue(ids, "The session test ran out of IDs"),
    },
  );
  return {
    database,
    selectedModels,
    selectedReasoningEfforts,
    selectedSystemPrompts,
    sessions,
  };
}

export function createSessionRequest(
  includeModel = true,
  reasoningEffort = "high",
  model = "gpt-4.1-mini",
): Request {
  return createAuthenticatedRequest(
    SESSIONS_PATH,
    {
      credentialId: CREDENTIAL_ID,
      ...(includeModel ? { model } : {}),
      prompt: "Inspect README.md",
      provider: "openai",
      reasoningEffort,
      runnerId: RUNNER_ID,
      workingDirectory: "/work/project",
    },
    "POST",
  );
}
