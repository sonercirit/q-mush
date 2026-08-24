import { expect } from "vitest";
import { RUNNERS_PATH, SESSIONS_PATH } from "../../shared/routes.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { createSessionStore } from "../../sync-engine/session-store.ts";
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
import { emptyRuntimes } from "./session-store-test-fixtures.ts";

export type ReassignmentSessionSetup = ReturnType<typeof connectedSessionSetup>;

export function createIdleStoredSession(setup: ReassignmentSessionSetup): void {
  const ids = [SESSION_ID, "race-message-id", "race-follow-up-id"];
  const store = createSessionStore(
    setup.database,
    () => ids.shift() ?? "unexpected-race-id",
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
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
  const handlers: Record<string, () => Promise<Response>> = {
    compact: () =>
      Promise.resolve(
        setup.sessions.compact(
          createAuthenticatedRequest(path, undefined, "POST"),
          SESSION_ID,
        ),
      ),
    continue: () =>
      setup.sessions.continue(
        createAuthenticatedRequest(path, undefined, "POST"),
        SESSION_ID,
      ),
    stop: () => stopSessionRequest(setup),
  };
  const handler = handlers[action];
  if (handler === undefined) {
    throw new Error("The session test action is invalid");
  }
  return handler();
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
