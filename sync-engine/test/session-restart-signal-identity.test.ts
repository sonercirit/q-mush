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

test("model discovery classifies its captured restart signal after recovery", async () => {
  const database = createAuthenticatedTestDatabase();
  const credentialId = "restart-credential";
  addTestProviderCredential(database, credentialId);
  const restart = new SessionRestartAbort();

  await expect(
    sessionAgentOptions({
      dependencies: {
        database,
        discoverModels: () => {
          restart.abort(new DOMException("restart", "AbortError"));
          restart.restore();
          return Promise.reject(new Error("restart cancellation"));
        },
        listRunnerOptions: () => ({ items: [], totalItems: 0 }),
        readCredential: () =>
          Promise.resolve({
            accountId: null,
            id: credentialId,
            isDefault: false,
            label: "Restart credential",
            secret: "secret",
            source: "api_key",
          }),
        restartSignal: () => restart.signal,
      },
      input: {
        category: "models",
        credentialId,
        page: 1,
        provider: "openai",
      },
      signal: new AbortController().signal,
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
    }),
  ).rejects.toThrow("restart cancellation");
  database.$client.close();
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
      restart.abort("restart");
      restart.restore();
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
