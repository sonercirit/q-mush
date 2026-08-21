import type { AppDatabase } from "../../shared/database.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";
import { createRunningTestSession } from "./session-store-create-hardening-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";
import {
  emptyRuntimes,
  testSessionInput,
} from "./session-store-test-fixtures.ts";

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
  const generateId = () =>
    takeValue(credentialIds, "The hardening test ran out of IDs");
  const store = new SessionStore(
    database,
    generateId,
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
  );
  return { database, store };
}

export function createSessionStoreTestSetup() {
  const setup = storeWithRunner();

  createRunningTestSession(
    setup.store,
    testSessionInput({
      credentialId: CREDENTIAL_ID,
      prompt: "Inspect the repository",
      runnerId: RUNNER_ID,
    }),
    SESSION_ID,
  );
  return setup;
}

export function testStoreReadResources(
  database: AppDatabase,
  store: SessionStore,
) {
  return {
    database,
    generateId: () => crypto.randomUUID(),
    toolSettings: () => DEFAULT_TOOL_SETTINGS,
    read: (userId: string, sessionId: string, workspaceId?: string) =>
      store.get(userId, sessionId, workspaceId),
  };
}
