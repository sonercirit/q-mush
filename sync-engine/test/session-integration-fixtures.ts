import type { AgentReasoningEffort } from "../../shared/agent-configuration.ts";
import type { AgentImage } from "../../shared/agent-images.ts";
import type { AgentModel } from "../../shared/agent-loop.ts";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { providerCredentials } from "../../shared/database/schema.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../../shared/provider-model-pricing.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RunnerCommandBroker,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import type { RunnerSummary } from "../../shared/runner-model.ts";
import { normalizeSearchText } from "../../shared/search.ts";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";
import {
  AgentModelDiscoveryError,
  type AgentModelDiscoverer,
} from "../../sync-engine/agent-model-discovery.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import type { OpenRouterProviderDiscoverer } from "../../sync-engine/openrouter-provider-discovery.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import type { AgentModelFactory } from "../../sync-engine/session-agent-models.ts";
import type { SessionDependencies } from "../../sync-engine/session-dependencies.ts";
import { readUserSpawnSession } from "../../sync-engine/session-input.ts";
import { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { WorkspaceStore } from "../../sync-engine/workspace-store.ts";
import {
  addTestProviderCredential,
  addTestUser,
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  createTestProviderCredential,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

export const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000061";
export const SESSION_ID = "018bcfe5-6800-7000-8000-000000000062";
export const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000063";
export const REPLACEMENT_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000073";
export const RUNNER_TOKEN = "qmr_session-runner-token";
export const RUNNER_COMMAND_ID = "agent-command-1";

type FixtureCredentials = Readonly<
  Partial<Record<"openai" | "openrouter", readonly ProviderCredentialAccess[]>>
>;

interface ConnectedSessionOptions {
  readonly broker?: RunnerCommandBroker;
  readonly commandId?: () => string;
  readonly credentials?: FixtureCredentials;
  readonly credentialGate?: Promise<void>;
  readonly database?: ReturnType<typeof createAuthenticatedTestDatabase>;
  readonly deletedCredentials?: FixtureCredentials;
  readonly foreignCredentials?: FixtureCredentials;
  readonly liveness?: SessionDependencies["liveness"];
  readonly modelDiscovery?: AgentModelDiscoverer;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly providerDiscovery?: OpenRouterProviderDiscoverer;
  readonly restartTiming?: SessionDependencies["restartTiming"];
  readonly onChange?: (userId: string, sessionId: string) => void;
  readonly onCredentialRead?: () => void;
  readonly readCredential?: (
    read: () => ProviderCredentialAccess | undefined,
  ) => Promise<ProviderCredentialAccess | undefined>;
  readonly runners?: readonly RunnerSummary[];
}

export function testCredentialId(credential: object): string {
  const selectedId: unknown = Reflect.get(credential, "id");
  if (typeof selectedId !== "string") {
    throw new Error("The model request credential ID is unavailable");
  }
  return selectedId;
}

export function connectedSessionSetup(
  model: AgentModel,
  credentialSource: ProviderCredentialAccess["source"] = "api_key",
  discoverModels?: AgentModelDiscoverer,
  options: ConnectedSessionOptions = {},
) {
  const database = options.database ?? createAuthenticatedTestDatabase();
  const now = options.now ?? (() => TEST_NOW);
  const authOptions = { database, now };
  const auth = createGoogleAuthFromEnvironment({}, authOptions);
  const runnerIds = [RUNNER_ID, REPLACEMENT_RUNNER_ID];
  const runnerTokens = ["session-runner-token", "replacement-runner-token"];
  const storedRunners = createRunnerIntegration(auth, {
    database,
    now,
    randomId: () => takeValue(runnerIds, "The test ran out of runner IDs"),
    randomToken: () =>
      takeValue(runnerTokens, "The test ran out of runner tokens"),
  });
  if (options.database === undefined) {
    storedRunners.collection(
      createAuthenticatedRequest("/api/runners", undefined, "POST"),
    );
    const registration = storedRunners.connect(RUNNER_TOKEN, {
      architecture: "x64",
      machineFingerprint: "session-test-machine",
      name: "workstation",
      platform: "linux",
    });
    if (registration === undefined) {
      throw new Error("The session test runner did not register");
    }
  }

  const insertedCredentialIds = new Set(
    options.database === undefined
      ? []
      : database
          .select({ id: providerCredentials.id })
          .from(providerCredentials)
          .all()
          .map(({ id }) => id),
  );
  if (options.database === undefined) {
    addTestProviderCredential(database, CREDENTIAL_ID);
    insertedCredentialIds.add(CREDENTIAL_ID);
  }
  const credential = createTestProviderCredential(
    CREDENTIAL_ID,
    credentialSource,
  );
  const configuredCredentials = {
    openai: options.credentials?.openai ?? [credential],
    openrouter: options.credentials?.openrouter ?? [],
  };
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
    readCredential: async (
      userId: string,
      credentialId: string,
      workspaceId?: string,
    ) => {
      options.onCredentialRead?.();
      await (options.credentialGate ?? Promise.resolve());
      const read = () => {
        const selected =
          userId === TEST_USER_ID
            ? configuredCredentials[provider].find(
                ({ id }) => id === credentialId,
              )
            : undefined;
        if (selected === undefined || workspaceId === undefined) {
          return selected;
        }
        const isGlobal = selected.isGlobal !== false;
        return (
          workspaceId === GLOBAL_WORKSPACE_ID
            ? isGlobal
            : isGlobal || selected.workspaceIds?.includes(workspaceId) === true
        )
          ? selected
          : undefined;
      };
      return options.readCredential === undefined
        ? read()
        : options.readCredential(read);
    },
  });
  const ids = Array.from({ length: 100 }, (_, index) =>
    index === 0
      ? SESSION_ID
      : `018bcfe5-6800-7000-8000-${String(index + 63).padStart(12, "0")}`,
  );
  const idBatch = options.database === undefined ? 0 : 100;
  const selectedModels: string[] = [];
  const selectedOpenRouterProviderTags: (string | undefined)[] = [];
  const selectedPricing: (ProviderModelPricing | null)[] = [];
  const selectedReasoningEfforts: (AgentReasoningEffort | null | undefined)[] =
    [];
  const selectedSystemPrompts: (string | undefined)[] = [];
  const selectedTools: (readonly AgentSessionToolName[] | undefined)[] = [];
  const notifications: {
    readonly sessionId: string;
    readonly userId: string;
  }[] = [];
  const runnerCommands: RunnerToolCommand[] = [];
  let latestRunnerCommand: RunnerToolCommand | undefined;
  const broker =
    options.broker ??
    new RunnerCommandBroker({
      commandId: options.commandId ?? (() => RUNNER_COMMAND_ID),
      deliver: (runnerId, command) => {
        if (command.tool === RUNNER_EXECUTION_CLEANUP_COMMAND) {
          queueMicrotask(() => {
            broker.complete(runnerId, command.id, {
              output: "cleaned",
              state: "completed",
            });
          });
          return true;
        }
        latestRunnerCommand = command;
        runnerCommands.push(command);
        return true;
      },
    });
  let listRunnerCalls = 0;
  const runnerIntegration: typeof storedRunners = {
    collection: (request) => storedRunners.collection(request),
    connect: (token, metadata) => storedRunners.connect(token, metadata),
    disconnected: (runner) => {
      storedRunners.disconnected(runner);
    },
    installer: (request) => storedRunners.installer(request),
    listForUser: (userId) => {
      listRunnerCalls += 1;
      return options.runners ?? storedRunners.listForUser(userId);
    },
    listOnlineForUser: (userId, queryOptions) => {
      listRunnerCalls += 1;
      const { limit, offset, search } = queryOptions;
      if (options.runners === undefined) {
        return storedRunners.listOnlineForUser(userId, queryOptions);
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
    onRemoved: (listener) => {
      storedRunners.onRemoved(listener);
    },
    onRemoving: (listener) => {
      storedRunners.onRemoving(listener);
    },
    onlineForUser: (userId) =>
      (options.runners ?? storedRunners.onlineForUser(userId)).filter(
        ({ status }) => status === "online",
      ),
    preflightRegistration: (token, metadata, activationId) =>
      storedRunners.preflightRegistration(token, metadata, activationId),
    receiptState: (token, metadata, receipt) =>
      storedRunners.receiptState(token, metadata, receipt),
    remove: (request, runnerId) => storedRunners.remove(request, runnerId),
    runnerIsAvailable: (userId, runnerId) =>
      storedRunners.runnerIsAvailable(userId, runnerId),
    runnerToken: (request) => storedRunners.runnerToken(request),
    seen: (runner) => {
      storedRunners.seen(runner);
    },
    settleActivationLifecycle: (activationId, lifecycle, restartId) =>
      storedRunners.settleActivationLifecycle(
        activationId,
        lifecycle,
        restartId,
      ),
    touchFinalizedActivation: (token, metadata, receipt) =>
      storedRunners.touchFinalizedActivation(token, metadata, receipt),
    setDefault: (request, runnerId) =>
      storedRunners.setDefault(request, runnerId),
    setScopes: (request, runnerId) =>
      storedRunners.setScopes(request, runnerId),
  };
  // Reject like an unreachable provider so metadata falls back to null; a
  // missing default would silently hit the live provider APIs on every
  // creation and spawn.
  const stubbedDiscovery = (): Promise<never> =>
    Promise.reject(
      new AgentModelDiscoveryError("Discovery is stubbed in tests", 503),
    );
  const configuredDiscoverModels =
    options.modelDiscovery ?? discoverModels ?? stubbedDiscovery;
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
      discoverModels: configuredDiscoverModels,
      discoverOpenRouterProviders:
        options.providerDiscovery ?? stubbedDiscovery,
      liveness: options.liveness ?? { setInterval: () => undefined },
      modelFactory:
        options.modelFactory ??
        ((factoryOptions) => {
          const {
            credential: selectedCredential,
            model: selectedModel,
            openRouterProviderTag,
            providerPricing,
            reasoningEffort,
            systemPrompt,
            tools,
          } = factoryOptions;
          if (selectedCredential.secret !== "provider-secret") {
            throw new Error("Unexpected test credential");
          }
          selectedModels.push(selectedModel);
          selectedOpenRouterProviderTags.push(openRouterProviderTag);
          selectedPricing.push(providerPricing);
          selectedReasoningEfforts.push(reasoningEffort);
          selectedSystemPrompts.push(systemPrompt);
          selectedTools.push(tools);
          // Forward the persistence hook so integration tests observe the
          // runtime -> store step-start composition, mirroring production
          // models that call startStep before each request. Delegate instead
          // of spreading: class-based test models keep prototype methods.
          const { onStepStart } = factoryOptions;
          return onStepStart === undefined
            ? model
            : {
                close: () => model.close?.(),
                complete: (...completeArguments) =>
                  model.complete(...completeArguments),
                startStep: () => {
                  model.startStep?.();
                  onStepStart();
                },
              };
        }),
      now,
      randomId: () => {
        const id = takeValue(ids, "The session test ran out of IDs");
        const suffix = Number.parseInt(id.slice(-12), 10) + idBatch;
        return `${id.slice(0, -12)}${String(suffix).padStart(12, "0")}`;
      },
      ...(options.restartTiming === undefined
        ? {}
        : { restartTiming: options.restartTiming }),
      workspaces: new WorkspaceStore(database),
    },
  );
  sessions.runnerOperational(RUNNER_ID);
  sessions.onChange((userId, sessionId) => {
    notifications.push({ sessionId, userId });
    options.onChange?.(userId, sessionId);
  });
  return {
    database,
    latestRunnerCommand: () => latestRunnerCommand,
    listRunnerCalls: () => listRunnerCalls,
    notifications,
    runnerCommands,
    runners: storedRunners,
    selectedModels,
    selectedOpenRouterProviderTags,
    selectedPricing,
    selectedReasoningEfforts,
    selectedSystemPrompts,
    selectedTools,
    sessions,
  };
}

export async function createSpawnSessionInput(
  parentSessionId: string,
  parentGeneration: number,
) {
  const requestInput: unknown = await createSessionRequest().json();
  if (typeof requestInput !== "object" || requestInput === null) {
    throw new TypeError("The session request fixture is invalid");
  }
  const input = readUserSpawnSession({
    ...requestInput,
    parentGeneration,
    parentSessionId,
  });
  if (input === undefined) {
    throw new TypeError("The spawn request fixture is invalid");
  }
  return input;
}

export function createSessionRequest(
  includeModel = true,
  reasoningEffort = "high",
  model = "gpt-4.1-mini",
  images: readonly AgentImage[] = [],
  autoCompact?: boolean,
  selectedProviderTag?: string,
  userContextTokenCap?: number,
): Request {
  return createAuthenticatedRequest(
    `${SESSIONS_PATH}?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
    {
      credentialId: CREDENTIAL_ID,
      ...(autoCompact === undefined ? {} : { autoCompact }),
      executionEnvironment: "bare_metal",
      ...(images.length === 0 ? {} : { images }),
      ...(includeModel ? { model } : {}),
      ...(selectedProviderTag === undefined
        ? {}
        : { openRouterProviderTag: selectedProviderTag }),
      prompt: "Inspect README.md",
      provider: "openai",
      reasoningEffort,
      runnerId: RUNNER_ID,
      tools: AGENT_SESSION_TOOL_NAMES,
      ...(userContextTokenCap === undefined ? {} : { userContextTokenCap }),
      workingDirectory: "/work/project",
    },
    "POST",
  );
}
