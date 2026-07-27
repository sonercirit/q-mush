import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { CreateAgentSession } from "../../sync-engine/session-store-create.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";
import { createSessionInput } from "./session-store-create-hardening-helpers.ts";
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
  "018bcfe5-6800-7000-8000-000000000051",
  "018bcfe5-6800-7000-8000-000000000052",
  "018bcfe5-6800-7000-8000-000000000053",
  "018bcfe5-6800-7000-8000-000000000054",
  "018bcfe5-6800-7000-8000-000000000055",
  "018bcfe5-6800-7000-8000-000000000056",
  "018bcfe5-6800-7000-8000-000000000057",
  "018bcfe5-6800-7000-8000-000000000058",
] as const;

export function testSessionInput(
  overrides: Partial<CreateAgentSession> = {},
): CreateAgentSession {
  const base = createSessionInput({
    credentialId: STORE_CREDENTIAL_ID,
    prompt: "Inspect the repository\nand make it shine",
    runnerId: STORE_RUNNER_ID,
  });
  return {
    ...base,
    images: [TEST_AGENT_IMAGE],
    maxContextTokens: 200_000,
    reasoningEffort: "high",
    tools: AGENT_SESSION_TOOL_NAMES,
    ...overrides,
  };
}

export function createStore() {
  const database = createAuthenticatedTestDatabase();
  addSessionTestRunner(database, "session-store-machine", STORE_RUNNER_ID);
  addTestProviderCredential(database, STORE_CREDENTIAL_ID);
  const ids = [...GENERATED_IDS];
  return {
    database,
    store: new SessionStore(database, () =>
      takeValue(ids, "The test ran out of session IDs"),
    ),
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
