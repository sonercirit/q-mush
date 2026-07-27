import { expect } from "vitest";
import { RUNNERS_PATH, SESSIONS_PATH } from "../../shared/routes.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  RUNNER_ID,
  SESSION_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";
import {
  createRunningTestSession,
  createSessionInput,
} from "./session-store-create-hardening-helpers.ts";

export type ReassignmentSessionSetup = ReturnType<typeof connectedSessionSetup>;

export function createIdleStoredSession(setup: ReassignmentSessionSetup): void {
  const ids = [SESSION_ID, "race-message-id", "race-follow-up-id"];
  const store = new SessionStore(
    setup.database,
    () => ids.shift() ?? "unexpected-race-id",
  );
  createRunningTestSession(
    store,
    createSessionInput({
      credentialId: "018bcfe5-6800-7000-8000-000000000063",
      prompt: "Existing session",
      runnerId: RUNNER_ID,
    }),
    SESSION_ID,
  );
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
      return stopSessionRequest(setup);
    default:
      throw new Error("The session test action is invalid");
  }
}

export function stopSessionRequest(
  setup: Pick<ReassignmentSessionSetup, "sessions">,
): Promise<Response> {
  const path = `${SESSIONS_PATH}/${SESSION_ID}/stop`;
  return setup.sessions.stop(
    createAuthenticatedRequest(path, undefined, "POST"),
    SESSION_ID,
  );
}

export function assignedRunnerRemoval(
  setup: Pick<ReassignmentSessionSetup, "runners">,
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

export async function expectRemovedRunner(
  setup: ReassignmentSessionSetup,
): Promise<void> {
  expect((await assignedRunnerRemoval(setup)).status).toBe(204);
}

export async function removeAssignedRunner(
  setup: ReassignmentSessionSetup,
): Promise<Response> {
  return assignedRunnerRemoval(setup);
}
