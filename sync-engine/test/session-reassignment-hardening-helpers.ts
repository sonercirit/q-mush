import { expect } from "vitest";
import type { AgentRecordedMessage } from "../../shared/agent-loop.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createUnavailableSession } from "./session-store-create-hardening-helpers.ts";
import {
  addReplacementRunner,
  removeTestRunnerAndExpect,
  type SessionStoreTestSetup,
} from "./session-store-reassignment-helpers.ts";
import { createSessionStoreTestSetup } from "./session-store-test-helpers.ts";

export type HardeningStoreSetup = SessionStoreTestSetup;

const HARDENING_REPLACEMENT_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000099";

export function idleHardeningStore(): SessionStoreTestSetup {
  const setup = createSessionStoreTestSetup();
  idleTestSession(setup.store, "018bcfe5-6800-7000-8000-000000000043");
  return setup;
}

export function removedHardeningStore(runnerId: string): SessionStoreTestSetup {
  const setup = createSessionStoreTestSetup();
  removeAssignedTestRunner(setup, runnerId);
  return setup;
}

export function removeAssignedTestRunner(
  setup: SessionStoreTestSetup,
  runnerId: string,
  now = TEST_NOW + 4,
): void {
  removeTestRunnerAndExpect(setup, runnerId, now);
}

export function expectRecoverableStoppedSession(
  store: SessionStore,
  sessionId: string,
): void {
  expect(store.get(TEST_USER_ID, sessionId)).toMatchObject({
    runnerRequired: true,
    status: "stopped",
  });
}

export function closeStoppedSessionCycle(
  setup: SessionStoreTestSetup,
  sessionId: string,
): void {
  expectRecoverableStoppedSession(setup.store, sessionId);
  reassignTestSession(setup, sessionId);
  closeHardeningDatabase(setup);
}

export function reassignTestSession(
  setup: SessionStoreTestSetup,
  sessionId: string,
  now = TEST_NOW + 4,
): void {
  addReplacementRunner(setup.database, HARDENING_REPLACEMENT_RUNNER_ID);
  expect(
    setup.store.reassign(
      TEST_USER_ID,
      sessionId,
      HARDENING_REPLACEMENT_RUNNER_ID,
      "/replacement/project",
      now,
    ).status,
  ).toBe("reassigned");
}

export function closeHardeningDatabase(setup: SessionStoreTestSetup): void {
  setup.database.$client.close();
}

export function fenceTestSession(
  setup: SessionStoreTestSetup,
  runnerId: string,
): ReturnType<SessionStore["get"]> {
  removeAssignedTestRunner(setup, runnerId);
  return setup.store.get(TEST_USER_ID, "018bcfe5-6800-7000-8000-000000000043");
}

export function expectAgentMessageRejected(
  store: SessionStore,
  sessionId: string,
  message: AgentRecordedMessage,
  generation?: number,
): void {
  expect(() => {
    if (generation === undefined) {
      store.appendCurrentAgentMessage(sessionId, message, TEST_NOW + 4);
    } else {
      store.appendRuntimeAgentMessages(
        sessionId,
        [message],
        TEST_NOW + 4,
        generation,
      );
    }
  }).toThrow("agent session was stopped");
}

export function assertUnavailableCreation(
  store: SessionStore,
  runnerId: string,
  prompt: string,
  parentSessionId?: string,
): void {
  const parent =
    parentSessionId === undefined
      ? undefined
      : store.get(TEST_USER_ID, parentSessionId);
  if (parentSessionId !== undefined && parent === undefined) {
    throw new Error("The spawn parent session is unavailable");
  }
  const result = createUnavailableSession(
    store,
    runnerId,
    prompt,
    parent === undefined
      ? undefined
      : { generation: parent.generation, id: parent.id },
  );
  expect(result).toEqual({ status: "runner_unavailable" });
  expectOneSession(store);
}

export function expectSessionUnchanged(
  store: SessionStore,
  sessionId: string,
  before: AgentSessionDetail | undefined,
): void {
  expect(store.get(TEST_USER_ID, sessionId)).toEqual(before);
}

function expectOneSession(store: SessionStore): void {
  expect(store.list(TEST_USER_ID)).toHaveLength(1);
}

function idleTestSession(store: SessionStore, sessionId: string): void {
  expect(store.transitionCurrent(sessionId, "idle", TEST_NOW + 2)).toBe(true);
}

export function queueStoppedTestSession(
  store: SessionStore,
  sessionId: string,
): void {
  expect(store.queue(TEST_USER_ID, sessionId, TEST_NOW + 5).status).toBe(
    "queued",
  );
}

export function stopTestSession(store: SessionStore, sessionId: string): void {
  expect(store.stop(TEST_USER_ID, sessionId, TEST_NOW + 3)).toBe(true);
}

export function requireSession(
  store: SessionStore,
  sessionId: string,
): AgentSessionDetail {
  const session = store.get(TEST_USER_ID, sessionId);
  if (session === undefined) {
    throw new Error("The running test session is unavailable");
  }
  return session;
}
