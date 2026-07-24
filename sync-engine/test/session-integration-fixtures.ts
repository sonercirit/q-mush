import { expect } from "vitest";
import type { AgentImage } from "../../shared/agent-images.ts";
import type { AgentModel } from "../../shared/agent-loop.ts";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../../shared/provider-model-pricing.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import {
  RunnerCommandBroker,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import type { AgentModelDiscoverer } from "../../sync-engine/agent-model-discovery.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import { createSessionIntegration } from "../../sync-engine/sessions.ts";
import {
  addTestProviderCredential,
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

export const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000061";
export const SESSION_ID = "018bcfe5-6800-7000-8000-000000000062";
export const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000063";
const RUNNER_TOKEN = "qmr_session-runner-token";
export const RUNNER_COMMAND_ID = "agent-command-1";

export interface ConnectedSessionOptions {
  readonly credentials?: Readonly<Record<string, string>>;
  readonly onCredentialSelected?: (secret: string) => void;
}

export function connectedSessionSetup(
  model: AgentModel,
  credentialSource: ProviderCredentialAccess["source"] = "api_key",
  discoverModels?: AgentModelDiscoverer,
  options: ConnectedSessionOptions = {},
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
  const registration = runners.connect(RUNNER_TOKEN, {
    architecture: "x64",
    machineFingerprint: "session-test-machine",
    name: "workstation",
    platform: "linux",
  });

  if (registration === undefined) {
    throw new Error("The session test runner did not register");
  }

  addTestProviderCredential(database, CREDENTIAL_ID);
  for (const credentialId of Object.keys(options.credentials ?? {})) {
    if (credentialId !== CREDENTIAL_ID) {
      addTestProviderCredential(database, credentialId);
    }
  }
  const credentials = options.credentials ?? {
    [CREDENTIAL_ID]: "provider-secret",
  };
  const reader = {
    readCredential: (userId: string, credentialId: string) => {
      const secret = credentials[credentialId];
      return userId === TEST_USER_ID && secret !== undefined
        ? {
            accountId: "provider-account",
            id: credentialId,
            isDefault: false,
            label: "Agent key",
            secret,
            source: credentialSource,
          }
        : undefined;
    },
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
    "018bcfe5-6800-7000-8000-000000000071",
    "018bcfe5-6800-7000-8000-000000000072",
  ];
  const selectedModels: string[] = [];
  const selectedPricing: (ProviderModelPricing | null)[] = [];
  const selectedReasoningEfforts: (string | null)[] = [];
  const selectedSystemPrompts: string[] = [];
  const selectedTools: (readonly AgentSessionToolName[])[] = [];
  const runnerCommands: RunnerToolCommand[] = [];
  let latestRunnerCommand: RunnerToolCommand | undefined;
  const broker = new RunnerCommandBroker({
    commandId: () => RUNNER_COMMAND_ID,
    deliver: (_runnerId, command) => {
      latestRunnerCommand = command;
      runnerCommands.push(command);
      return true;
    },
  });
  const sessions = createSessionIntegration(
    auth,
    runners,
    { openai: reader, openrouter: reader },
    {
      braveSearch: {
        execute: () =>
          Promise.resolve("Error: no Brave Search API keys are available."),
      },
      broker,
      database,
      ...(discoverModels === undefined ? {} : { discoverModels }),
      modelFactory: ({
        credential: selectedCredential,
        model: selectedModel,
        providerPricing,
        reasoningEffort,
        systemPrompt,
        tools,
      }) => {
        options.onCredentialSelected?.(selectedCredential.secret);
        if (options.credentials === undefined) {
          expect(selectedCredential.secret).toBe("provider-secret");
        }
        selectedModels.push(selectedModel);
        selectedPricing.push(providerPricing);
        selectedReasoningEfforts.push(reasoningEffort);
        selectedSystemPrompts.push(systemPrompt);
        selectedTools.push(tools);
        return model;
      },
      now: () => TEST_NOW,
      randomId: () => takeValue(ids, "The session test ran out of IDs"),
    },
  );
  return {
    database,
    latestRunnerCommand: () => latestRunnerCommand,
    runnerCommands,
    selectedModels,
    selectedPricing,
    selectedReasoningEfforts,
    selectedSystemPrompts,
    selectedTools,
    sessions,
  };
}

export function createSessionRequest(
  includeModel = true,
  reasoningEffort = "high",
  model = "gpt-4.1-mini",
  images: readonly AgentImage[] = [],
): Request {
  return createAuthenticatedRequest(
    SESSIONS_PATH,
    {
      credentialId: CREDENTIAL_ID,
      ...(images.length === 0 ? {} : { images }),
      ...(includeModel ? { model } : {}),
      prompt: "Inspect README.md",
      provider: "openai",
      reasoningEffort,
      runnerId: RUNNER_ID,
      tools: AGENT_SESSION_TOOL_NAMES,
      workingDirectory: "/work/project",
    },
    "POST",
  );
}
