import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { CreateAgentSession } from "../../sync-engine/session-store-create.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { requireCreatedSession } from "./session-store-result-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";

export const STORE_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const STORE_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000042";
export const STORE_SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";
const GENERATED_IDS = [
  STORE_SESSION_ID,
  "018bcfe5-6800-7000-8000-000000000044",
  "018bcfe5-6800-7000-8000-000000000045",
  "018bcfe5-6800-7000-8000-000000000046",
  "018bcfe5-6800-7000-8000-000000000047",
  "018bcfe5-6800-7000-8000-000000000048",
  "018bcfe5-6800-7000-8000-000000000049",
  "018bcfe5-6800-7000-8000-000000000050",
] as const;

function testSessionInput() {
  return {
    credentialId: STORE_CREDENTIAL_ID,
    autoCompact: true,
    images: [TEST_AGENT_IMAGE],
    maxContextTokens: 200_000,
    model: "gpt-4.1-mini",
    prompt: "Inspect the repository\nand make it shine",
    provider: "openai" as const,
    providerPricing: null,
    reasoningEffort: "high" as const,
    runnerId: STORE_RUNNER_ID,
    tools: AGENT_SESSION_TOOL_NAMES,
    userId: TEST_USER_ID,
    workingDirectory: "/work/project",
  };
}

export function createStore() {
  const database = createAuthenticatedTestDatabase();
  addSessionTestRunner(database, "session-store-machine", STORE_RUNNER_ID);
  addTestProviderCredential(database, STORE_CREDENTIAL_ID);
  const ids = [...GENERATED_IDS];
  return {
    database,
    store: new SessionStore(database, () => {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The test ran out of session IDs");
      }
      return id;
    }),
  };
}

export function createTestSession(
  store: SessionStore,
  now = TEST_NOW,
  overrides: Partial<CreateAgentSession> = {},
) {
  return requireCreatedSession(
    store.create({ ...testSessionInput(), ...overrides }, now),
  );
}
