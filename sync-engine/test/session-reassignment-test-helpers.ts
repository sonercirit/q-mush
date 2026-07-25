import { expect } from "vitest";
import { RUNNERS_PATH, SESSIONS_PATH } from "../../shared/routes.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  RUNNER_ID,
  SESSION_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";

export type ReassignmentSessionSetup = ReturnType<typeof connectedSessionSetup>;

export function createIdleStoredSession(setup: ReassignmentSessionSetup): void {
  const ids = [SESSION_ID, "race-message-id", "race-follow-up-id"];
  const store = new SessionStore(
    setup.database,
    () => ids.shift() ?? "unexpected-race-id",
  );
  const created = store.create(
    {
      autoCompact: true,
      credentialId: "018bcfe5-6800-7000-8000-000000000063",
      images: [],
      maxContextTokens: null,
      model: "gpt-4.1-mini",
      prompt: "Existing session",
      provider: "openai",
      providerPricing: null,
      reasoningEffort: null,
      runnerId: RUNNER_ID,
      tools: [],
      userId: TEST_USER_ID,
      workingDirectory: "/work/project",
    },
    1_700_000_000_000,
  );
  expect(created.status).toBe("created");
  expect(
    store.transitionCurrent(SESSION_ID, "running", 1_700_000_000_001),
  ).toBe(true);
  expect(store.transitionCurrent(SESSION_ID, "idle", 1_700_000_000_002)).toBe(
    true,
  );
}

export async function postSessionAction(
  setup: ReassignmentSessionSetup,
  action: string,
): Promise<Response> {
  const path = `${SESSIONS_PATH}/${SESSION_ID}/${action}`;
  switch (action) {
    case "compact":
      return setup.sessions.compact(
        createAuthenticatedRequest(path, undefined, "POST"),
        SESSION_ID,
      );
    case "continue":
      return setup.sessions.continue(
        createAuthenticatedRequest(path, undefined, "POST"),
        SESSION_ID,
      );
    case "stop":
      return setup.sessions.stop(
        createAuthenticatedRequest(path, undefined, "POST"),
        SESSION_ID,
      );
    default:
      throw new Error("The session test action is invalid");
  }
}

export async function expectRemovedRunner(
  setup: ReassignmentSessionSetup,
): Promise<void> {
  expect((await removeAssignedRunner(setup)).status).toBe(204);
}

export async function removeAssignedRunner(
  setup: ReassignmentSessionSetup,
): Promise<Response> {
  return setup.runners.remove(
    createAuthenticatedRequest(
      `${RUNNERS_PATH}/${RUNNER_ID}`,
      undefined,
      "DELETE",
    ),
    RUNNER_ID,
  );
}
