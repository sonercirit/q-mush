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
import type { RunnerSummary } from "../../shared/runner-model.ts";
import { normalizeSearchText } from "../../shared/search.ts";
import type { AgentModelDiscoverer } from "../../sync-engine/agent-model-discovery.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import { createSessionIntegration } from "../../sync-engine/sessions.ts";
import {
  addTestProviderCredential,
  addTestUser,
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

export const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000061";
export const SESSION_ID = "018bcfe5-6800-7000-8000-000000000062";
export const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000063";
const RUNNER_TOKEN = "qmr_session-runner-token";
export const RUNNER_COMMAND_ID = "agent-command-1";

type FixtureCredentials = Readonly<
  Partial<Record<"openai" | "openrouter", readonly ProviderCredentialAccess[]>>
>;

export function connectedSessionSetup(
  model: AgentModel,
  credentialSource: ProviderCredentialAccess["source"] = "api_key",
  discoverModels?: AgentModelDiscoverer,
  options: {
    readonly credentials?: FixtureCredentials;
    readonly deletedCredentials?: FixtureCredentials;
    readonly foreignCredentials?: FixtureCredentials;
    readonly runners?: readonly RunnerSummary[];
  } = {},
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
  const credential: ProviderCredentialAccess = {
    accountId: "provider-account",
    id: CREDENTIAL_ID,
    isDefault: false,
    label: "Agent key",
    secret: "provider-secret",
    source: credentialSource,
  };
  const configuredCredentials = {
    openai: options.credentials?.openai ?? [credential],
    openrouter: options.credentials?.openrouter ?? [],
  };
  const insertedCredentialIds = new Set([CREDENTIAL_ID]);
  const foreignCredentials = options.foreignCredentials;
  if (
    foreignCredentials?.openai !== undefined ||
    foreignCredentials?.openrouter !== undefined
  ) {
    addTestUser(database);
  }
  const configuredCredential = (
    configured: ProviderCredentialAccess,
    isDeleted: boolean,
    userId: string,
  ) => ({ configured, isDeleted, userId });
  for (const provider of ["openai", "openrouter"] as const) {
    const storedCredentials = [
      ...configuredCredentials[provider].map((configured) =>
        configuredCredential(configured, false, TEST_USER_ID),
      ),
      ...(options.deletedCredentials?.[provider] ?? []).map((configured) =>
        configuredCredential(configured, true, TEST_USER_ID),
      ),
      ...(foreignCredentials?.[provider] ?? []).map((configured) =>
        configuredCredential(configured, false, TEST_FOREIGN_USER_ID),
      ),
    ];
    for (const { configured, isDeleted, userId } of storedCredentials) {
      if (!insertedCredentialIds.has(configured.id)) {
        addTestProviderCredential(database, configured.id, provider, {
          accountId: configured.accountId,
          isDefault: configured.isDefault,
          isDeleted,
          label: configured.label,
          source: configured.source,
          userId,
        });
        insertedCredentialIds.add(configured.id);
      }
    }
  }
  const reader = (provider: "openai" | "openrouter") => ({
    readCredential: (userId: string, credentialId: string) =>
      userId === TEST_USER_ID
        ? configuredCredentials[provider].find(({ id }) => id === credentialId)
        : undefined,
  });
  const ids = Array.from({ length: 100 }, (_, index) =>
    index === 0
      ? SESSION_ID
      : `018bcfe5-6800-7000-8000-${String(index + 63).padStart(12, "0")}`,
  );
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
  let listRunnerCalls = 0;
  const runnerIntegration: typeof runners = {
    collection: (request) => runners.collection(request),
    connect: (token, metadata) => runners.connect(token, metadata),
    disconnected: (runner) => {
      runners.disconnected(runner);
    },
    installer: (request) => runners.installer(request),
    listForUser: (userId) => {
      listRunnerCalls += 1;
      return options.runners ?? runners.listForUser(userId);
    },
    listOnlineForUser: (userId, queryOptions) => {
      listRunnerCalls += 1;
      const { limit, offset, search } = queryOptions;
      if (options.runners === undefined) {
        return runners.listOnlineForUser(userId, queryOptions);
      }
      const query =
        search === undefined ? undefined : normalizeSearchText(search);
      const matching = options.runners.filter(
        (runner) =>
          runner.status === "online" &&
          (query === undefined ||
            [runner.id, runner.name, runner.platform, runner.architecture].some(
              (value) =>
                value !== null && normalizeSearchText(value).includes(query),
            )),
      );
      return {
        items: matching.slice(offset, offset + limit),
        totalItems: matching.length,
      };
    },
    remove: (request, runnerId) => runners.remove(request, runnerId),
    runnerIsAvailable: (userId, runnerId) =>
      runners.runnerIsAvailable(userId, runnerId),
    runnerToken: (request) => runners.runnerToken(request),
    seen: (runner) => {
      runners.seen(runner);
    },
    setDefault: (request, runnerId) => runners.setDefault(request, runnerId),
  };
  const sessions = createSessionIntegration(
    auth,
    runnerIntegration,
    { openai: reader("openai"), openrouter: reader("openrouter") },
    {
      braveSearch: {
        execute: () =>
          Promise.resolve("Error: no Brave Search API keys are available."),
      },
      broker,
      database,
      ...(discoverModels === undefined ? {} : { discoverModels }),
      modelFactory: (factoryOptions) => {
        const {
          credential: selectedCredential,
          model: selectedModel,
          providerPricing,
          reasoningEffort,
          systemPrompt,
          tools,
        } = factoryOptions;
        if (selectedCredential.secret !== "provider-secret") {
          throw new Error("Unexpected test credential");
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
    listRunnerCalls: () => listRunnerCalls,
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
