import { createHash } from "node:crypto";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { runners } from "../../shared/database/schema.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000042";
export const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";
export const USER_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000044";
export const THINKING_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000045";
export const ASSISTANT_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000046";
export const TOOL_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000047";

export function testSessionInput() {
  return {
    credentialId: CREDENTIAL_ID,
    autoCompact: true,
    images: [TEST_AGENT_IMAGE],
    maxContextTokens: 200_000,
    model: "gpt-4.1-mini",
    prompt: "Inspect the repository\nand make it shine",
    provider: "openai" as const,
    providerPricing: null,
    reasoningEffort: "high" as const,
    runnerId: RUNNER_ID,
    tools: AGENT_SESSION_TOOL_NAMES,
    userId: TEST_USER_ID,
    workingDirectory: "/work/project",
  };
}

export function createTestSession(store: SessionStore) {
  return store.create(testSessionInput(), TEST_NOW);
}

export function markTestSessionRunning(store: SessionStore): void {
  if (!store.mark(SESSION_ID, "running", TEST_NOW + 1)) {
    throw new Error("The test session could not be marked running");
  }
}

export function runningStore(): ReturnType<typeof createStore> {
  const setup = createStore();
  createTestSession(setup.store);
  markTestSessionRunning(setup.store);
  return setup;
}

export function createStore() {
  const database = createAuthenticatedTestDatabase();
  const timestamp = new Date(TEST_NOW);
  database
    .insert(runners)
    .values({
      ...testAuditFields(),
      architecture: "x64",
      id: RUNNER_ID,
      lastSeenAt: timestamp,
      machineFingerprint: "session-store-machine",
      name: "workstation",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update("runner-token")
        .digest("base64url"),
      userId: TEST_USER_ID,
    })
    .run();
  addTestProviderCredential(database, CREDENTIAL_ID);
  const ids = [
    SESSION_ID,
    USER_MESSAGE_ID,
    THINKING_MESSAGE_ID,
    ASSISTANT_MESSAGE_ID,
    TOOL_MESSAGE_ID,
    "018bcfe5-6800-7000-8000-000000000048",
    "018bcfe5-6800-7000-8000-000000000049",
    "018bcfe5-6800-7000-8000-000000000050",
    "018bcfe5-6800-7000-8000-000000000051",
    "018bcfe5-6800-7000-8000-000000000052",
    "018bcfe5-6800-7000-8000-000000000053",
    "018bcfe5-6800-7000-8000-000000000054",
    "018bcfe5-6800-7000-8000-000000000055",
    "018bcfe5-6800-7000-8000-000000000056",
    "018bcfe5-6800-7000-8000-000000000057",
    "018bcfe5-6800-7000-8000-000000000058",
  ];
  return {
    database,
    store: new SessionStore(database, () =>
      takeValue(ids, "The test ran out of session IDs"),
    ),
  };
}
