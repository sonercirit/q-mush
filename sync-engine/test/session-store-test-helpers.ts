import { expect } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000042";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";
const MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000044";
const ASSISTANT_ID = "018bcfe5-6800-7000-8000-000000000045";
const TOOL_ID = "018bcfe5-6800-7000-8000-000000000046";
const INTERRUPTED_ID = "018bcfe5-6800-7000-8000-000000000047";

function storeWithRunner() {
  const database = createAuthenticatedTestDatabase();
  addSessionTestRunner(database, "session-store-hardening-machine", RUNNER_ID);
  addTestProviderCredential(database, CREDENTIAL_ID);
  const credentialIds = [
    SESSION_ID,
    MESSAGE_ID,
    ASSISTANT_ID,
    TOOL_ID,
    INTERRUPTED_ID,
  ];
  const generateId = () => {
    const id = credentialIds.shift();
    if (id === undefined) {
      throw new Error("The hardening test ran out of IDs");
    }
    return id;
  };
  return {
    database,
    store: new SessionStore(database, generateId),
  };
}

export function createSessionStoreTestSetup() {
  const setup = storeWithRunner();
  const created = setup.store.create(
    {
      autoCompact: true,
      credentialId: CREDENTIAL_ID,
      images: [TEST_AGENT_IMAGE],
      maxContextTokens: 200_000,
      model: "gpt-4.1-mini",
      prompt: "Inspect the repository",
      provider: "openai",
      providerPricing: null,
      reasoningEffort: "high",
      runnerId: RUNNER_ID,
      tools: AGENT_SESSION_TOOL_NAMES,
      userId: TEST_USER_ID,
      workingDirectory: "/work/project",
    },
    TEST_NOW,
  );
  expect(created.status).toBe("created");
  expect(
    setup.store.transitionCurrent(SESSION_ID, "running", TEST_NOW + 1),
  ).toBe(true);
  return setup;
}
