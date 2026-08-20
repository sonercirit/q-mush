import { expect, test } from "vitest";
import { sessionAgentOptions } from "../session-agent-options-action.ts";
import { SessionRestartAbort } from "../session-restart-abort.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
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
          restart.abort(new Error("restart"));
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

import { executeSessionAgentTool } from "../session-agent-tools.ts";
import {
  agentActionsSetup,
  parseToolOutput,
  spawnedSession,
  spawnInput,
} from "./session-launch-race.test.ts";

test("recovery replacement cannot create a child", async () => {
  let restart = new AbortController();
  const setup = agentActionsSetup("none", false, {
    discoverSessionMetadata: () => {
      restart.abort(new Error("restart"));
      restart = new AbortController();
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
