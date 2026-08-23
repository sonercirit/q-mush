import { expect, test, vi } from "vitest";
import { CredentialPoolBalancer } from "../../shared/credential-pool-balancer.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import type { AgentModelDiscoverer } from "../agent-model-discovery.ts";
import { ModelCredentialPool } from "../model-credential-pool.ts";
import { sessionAgentOptions } from "../session-agent-options-action.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import { createSessionWithCredentialPool } from "../session-realtime-create.ts";
import {
  createSessionRestartAbort,
  type SessionRestartAbort,
} from "../session-restart-abort.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  createTestProviderCredential,
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";

async function expectModelDiscoveryFailure(options: {
  readonly credentialId: string;
  readonly discoverModels: AgentModelDiscoverer;
  readonly readCredential: () => Promise<
    ReturnType<typeof createTestProviderCredential>
  >;
  readonly restart: SessionRestartAbort;
}): Promise<void> {
  const database = createAuthenticatedTestDatabase();
  addTestProviderCredential(database, options.credentialId);
  await expect(
    sessionAgentOptions({
      dependencies: {
        database,
        discoverModels: options.discoverModels,
        listRunnerOptions: () => ({ items: [], totalItems: 0 }),
        readCredential: options.readCredential,
        restartSignal: () => options.restart.signal,
      },
      input: {
        category: "models",
        credentialId: options.credentialId,
        page: 1,
        provider: "openai",
      },
      signal: new AbortController().signal,
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
    }),
  ).rejects.toThrow("restart cancellation");
  database.$client.close();
}

function recoverFromRestart(
  restart: SessionRestartAbort,
  reason: unknown,
): void {
  restart.abort(reason);
  restart.restore();
}

test("model discovery retains restart identity across credential resolution", async () => {
  const credentialId = "restart-credential-resolution";
  const restart = createSessionRestartAbort();
  await expectModelDiscoveryFailure({
    credentialId,
    discoverModels: (_provider, _credential, signal) => {
      expect(signal?.aborted).toBe(true);
      return Promise.reject(new Error("restart cancellation"));
    },
    readCredential: () => {
      recoverFromRestart(restart, "restart");
      return Promise.resolve(createTestProviderCredential(credentialId));
    },
    restart,
  });
});

test("model discovery classifies its captured restart signal after recovery", async () => {
  const restart = createSessionRestartAbort();
  await expectModelDiscoveryFailure({
    credentialId: "restart-credential",
    discoverModels: async () => {
      await Promise.resolve();
      recoverFromRestart(restart, new DOMException("restart", "AbortError"));
      throw new Error("restart cancellation");
    },
    readCredential: () =>
      Promise.resolve(createTestProviderCredential("restart-credential")),
    restart,
  });
});

import {
  agentActionsSetup,
  parseToolOutput,
  spawnedSession,
  spawnInput,
} from "./session-launch-race-helpers.ts";

test("recovery replacement cannot create a child", async () => {
  const restart = createSessionRestartAbort();
  const credential = createTestProviderCredential("spawn-restart-credential");
  const launchSession = vi.fn(() => true);
  // The pool uses its own database so its credential rows remain representative
  // while the spawned-session setup independently owns the session store.
  const poolSetup = agentActionsSetup("none", false, {
    launchSession,
    restartSignal: () => restart.signal,
  });
  const poolDependencies = {
    database: poolSetup.database,
    readCredential: () => Promise.resolve(credential),
  };
  const pool = new ModelCredentialPool(
    poolDependencies,
    new CredentialPoolBalancer(),
  );
  vi.spyOn(pool, "candidates").mockImplementation(() => {
    recoverFromRestart(restart, "restart");
    return Promise.resolve([credential]);
  });
  const setup = agentActionsSetup("none", false, {
    launchSession,
    modelCredentialPool: pool,
    restartSignal: () => restart.signal,
  });
  const caller = new AbortController();
  const spawn = {
    ...spawnInput(setup, "blocked"),
    credentialId: balancedCredentialId(setup.parent.provider),
  };
  const output = await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    spawn,
    caller.signal,
  );
  const result = parseToolOutput(output);
  expect(result).toEqual({ error: "server_restarting" });
  expect(spawnedSession(setup)).toBeUndefined();
  expect(launchSession).not.toHaveBeenCalled();
  poolSetup.database.$client.close();
  setup.database.$client.close();
});

test("already-aborted restart returns structured spawn error", async () => {
  const restart = createSessionRestartAbort();
  restart.abort(new DOMException("restart", "AbortError"));
  const setup = agentActionsSetup("none", false, {
    restartSignal: () => restart.signal,
  });
  const input = spawnInput(setup, "already restarting");
  input.credentialId = balancedCredentialId(setup.parent.provider);
  const result = await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    input,
    new AbortController().signal,
  );
  const parsed: unknown = parseToolOutput(result);
  expect(parsed).toEqual({ error: "server_restarting" });
  const sessionsAfterAttempt = setup.store.list(TEST_USER_ID);
  expect(sessionsAfterAttempt).toHaveLength(1);
  const sqlite = setup.database.$client;
  sqlite.close();
});

test("restart-aborted credential candidates return server restarting", async () => {
  const restart = createSessionRestartAbort();
  const credential = createTestProviderCredential("rejecting-candidate");
  const poolSetup = agentActionsSetup("none", false);
  const pool = new ModelCredentialPool(
    {
      database: poolSetup.database,
      readCredential: () => {
        restart.abort(new DOMException("restart", "AbortError"));
        return Promise.resolve(credential);
      },
    },
    new CredentialPoolBalancer(),
  );
  const setup = agentActionsSetup("none", false, {
    modelCredentialPool: pool,
    restartSignal: () => restart.signal,
  });
  const spawnArguments = spawnInput(setup, "blocked candidates");
  spawnArguments.credentialId = balancedCredentialId(setup.parent.provider);
  const output = await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    spawnArguments,
    AbortSignal.timeout(10_000),
  );
  const decoded = parseToolOutput(output);
  const expectedCancellation: unknown = { error: "server_restarting" };
  expect(decoded).toEqual(expectedCancellation);
  const remainingSessions = setup.store.list(TEST_USER_ID);
  for (const database of [poolSetup.database, setup.database]) {
    database.$client.close();
  }
  expect(remainingSessions).toHaveLength(1);
});

test("restart-aborted metadata rejection returns server restarting", async () => {
  const restart = createSessionRestartAbort();
  const restartReason = new DOMException("restart", "AbortError");
  function restartSignal(): AbortSignal {
    return restart.signal;
  }
  const setup = agentActionsSetup("none", false, {
    discoverSessionMetadata: () => {
      restart.abort(restartReason);
      return Promise.reject(restartReason);
    },
    restartSignal,
  });
  const callerSignal = new AbortController().signal;
  const input = spawnInput(setup, "restart canceled metadata");
  const output = await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    input,
    callerSignal,
  );
  expect(spawnedSession(setup)).toBeUndefined();
  const decoded = parseToolOutput(output);
  setup.database.$client.close();
  expect(decoded).toEqual({ error: "server_restarting" });
});

test("caller-aborted metadata rejection retains the caller reason", async () => {
  const caller = new AbortController();
  const callerReason = new Error("caller cancellation");
  const setup = agentActionsSetup("none", false, {
    discoverSessionMetadata: (
      _input,
      _credential,
      _userId,
      _balanced,
      signal,
    ) => {
      caller.abort(callerReason);
      return Promise.reject(
        signal?.reason instanceof Error ? signal.reason : callerReason,
      );
    },
  });
  // Deliberately use the direct-credential branch, unlike the pool cases above.
  let rejectedReason: unknown;
  const actions = {
    ...setup.actions,
    spawnSession: async (
      ...arguments_: Parameters<typeof setup.actions.spawnSession>
    ) => {
      try {
        return await setup.actions.spawnSession(...arguments_);
      } catch (error) {
        rejectedReason = error;
        throw error;
      }
    },
  };
  await executeSessionAgentTool(
    actions,
    "spawn_session",
    spawnInput(setup, "caller canceled"),
    caller.signal,
  );
  expect(rejectedReason).toBe(callerReason);
  expect(spawnedSession(setup)).toBeUndefined();
  setup.database.$client.close();
});

import { EMPTY_SESSION_REQUEST_MODEL_METADATA } from "./session-race-test-helpers.ts";
import { restartReplacementDiscovery } from "./session-restart-gate-fixtures.ts";

test("recovery replacement cannot create a realtime session", async () => {
  const create = vi.fn();
  const database = createAuthenticatedTestDatabase();
  const credential = createTestProviderCredential("credential");
  addTestProviderCredential(database, credential.id);
  const replacement = restartReplacementDiscovery({
    defaultModel: "model",
    models: [
      {
        ...EMPTY_SESSION_REQUEST_MODEL_METADATA,
        contextWindow: null,
        id: "model",
        inputModalities: ["text" as const],
        label: "Model",
        outputModalities: ["text" as const],
        pricing: null,
        reasoningEfforts: [],
      },
    ],
  });
  const discoverModels: AgentModelDiscoverer = replacement.discover;
  const dependencies = {
    discoverModels,
    discoverOpenRouterProviders: () => Promise.resolve({ providers: [] }),
    launch: () => false,
    modelCredentialPool: new ModelCredentialPool(
      {
        database,
        readCredential: () => Promise.resolve(credential),
      },
      new CredentialPoolBalancer(),
    ),
    notify: () => undefined,
    now: () => 0,
    readCredential: () => Promise.resolve(credential),
    restartSignal: replacement.signal,
    runnerIsAvailable: () => true,
    runtimes: { accepts: () => true, pendingRestart: () => undefined },
    store: {
      create,
      get: () => undefined,
      pauseQueuedForRestart: () => false,
      transitionRuntime: () => false,
    },
  };
  const creation = createSessionWithCredentialPool({
    dependencies,
    input: Object.freeze({
      autoCompact: true,
      credentialId: credential.id,
      executionEnvironment: "bare_metal",
      images: [],
      model: "model",
      openRouterProviderTag: null,
      parentUserInitiated: false,
      prompt: "prompt",
      provider: "openai",
      reasoningEffort: null,
      runnerId: "runner",
      tools: [],
      workingDirectory: "/tmp",
    }),
    user: TEST_AUTHENTICATED_USER,
    workspaceId: TEST_WORKSPACE_ID,
  });
  await expect(creation).rejects.toMatchObject({ code: "server_restarting" });
  expect(create).not.toHaveBeenCalled();
  database.$client.close();
});

import { createAttachmentFallbackIntegration } from "../attachment-fallback-integration.ts";

test("attachment fallback validation retains restart identity across credential lookup", async () => {
  const database = createAuthenticatedTestDatabase();
  const restart = createSessionRestartAbort();
  const providerDiscovery = vi.fn(() => Promise.resolve({ providers: [] }));
  const integration = createAttachmentFallbackIntegration({
    database,
    discoverModels: async (_provider, _credential, signal) => {
      await Promise.resolve();
      expect(signal).toBe(restart.signal);
      if (signal?.aborted !== true) throw new Error("signal was not aborted");
      throw new Error("restart cancellation");
    },
    discoverOpenRouterProviders: providerDiscovery,
    generateId: () => crypto.randomUUID(),
    now: () => 0,
    providers: {
      openrouter: {
        readCredential: () => Promise.resolve(undefined),
      },
      openai: {
        readCredential: () => {
          const credential = createTestProviderCredential("credential");
          restart.abort("restart");
          restart.restore();
          return Promise.resolve(credential);
        },
      },
    },
    requests: {
      authenticate: (_request, _method, action) =>
        action(TEST_AUTHENTICATED_USER),
      forUser: (_request, action) => action(TEST_AUTHENTICATED_USER),
    },
    restartSignal: () => restart.signal,
  });
  const response = await integration.api.collection(
    new Request("http://localhost/api/sessions/attachment-fallbacks", {
      body: JSON.stringify({
        credentialId: "credential",
        modality: "image",
        model: "model",
        openRouterProviderTag: null,
        provider: "openai",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    }),
  );
  expect(response.status).toBe(409);
  expect(providerDiscovery).not.toHaveBeenCalled();
  database.$client.close();
});
