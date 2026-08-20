import { expect, test, vi } from "vitest";
import { CredentialPoolBalancer } from "../../shared/credential-pool-balancer.ts";
import type { AgentModelDiscoverer } from "../agent-model-discovery.ts";
import { ModelCredentialPool } from "../model-credential-pool.ts";
import { sessionAgentOptions } from "../session-agent-options-action.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import { createSessionWithCredentialPool } from "../session-realtime-create.ts";
import { SessionRestartAbort } from "../session-restart-abort.ts";
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
  const restart = new SessionRestartAbort();
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
  const restart = new SessionRestartAbort();
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
  const restart = new SessionRestartAbort();
  const setup = agentActionsSetup("none", false, {
    discoverSessionMetadata: () => {
      recoverFromRestart(restart, "restart");
      return Promise.resolve({
        contextWindow: null,
        maxContextTokens: null,
        maxOutputTokens: null,
        providerPricing: null,
        adaptiveThinking: false,
      });
    },
    restartSignal: () => restart.signal,
  });
  const caller = new AbortController();
  const output = await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    spawnInput(setup, "blocked"),
    caller.signal,
  );
  const result = parseToolOutput(output);
  expect(result).toEqual({ error: "server_restarting" });
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
  const restart = new SessionRestartAbort();
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
