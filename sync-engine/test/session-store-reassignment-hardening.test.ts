import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { createRunnerStore } from "../../sync-engine/runner-store.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  assertUnavailableCreation,
  closeHardeningDatabase,
  closeStoppedSessionCycle,
  expectRecoverableStoppedSession,
  expectSessionUnchanged,
  fenceTestSession,
  idleHardeningStore,
  queueStoppedTestSession,
  reassignTestSession,
  removeAssignedTestRunner,
  removedHardeningStore,
  requireSession,
  stopTestSession,
} from "./session-reassignment-hardening-helpers.ts";
import {
  expectLateModelWritesRejected,
  expectRejectedWrite,
  withRejectedWriteSetup,
} from "./session-store-late-write-helpers.ts";
import {
  addForeignReplacementRunner,
  addReplacementRunner,
  expectStoredSession,
  removeTestRunner,
} from "./session-store-reassignment-helpers.ts";
import { createSessionStoreTestSetup } from "./session-store-test-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";

const LATE_TOOL_MESSAGE = {
  content: "Late tool output",
  role: "tool" as const,
  toolCallId: "old-call",
  toolName: "bash",
};

function runningStore() {
  return createSessionStoreTestSetup();
}

function reassignSession(
  store: SessionStore,
  runnerId: string,
  workingDirectory: string,
  options: { readonly now?: number; readonly userId?: string } = {},
) {
  return store.reassign(
    options.userId ?? TEST_USER_ID,
    SESSION_ID,
    runnerId,
    workingDirectory,
    options.now ?? TEST_NOW + 4,
  );
}

function pauseRunningSessionForRestart(store: SessionStore): void {
  const running = requireSession(store, SESSION_ID);
  const runningExecution = {
    generation: running.generation,
    sessionId: running.id,
  };
  expect(
    store.pauseRunningForRestart(
      runningExecution,
      "server",
      "restart-reassign",
      "agent",
      TEST_NOW + 2,
    ),
  ).toBe(true);
}

function removeRunner(
  database: Parameters<typeof removeTestRunner>[0]["database"],
  store: SessionStore,
): void {
  expect(removeTestRunner({ database, store }, RUNNER_ID, TEST_NOW + 4)).toBe(
    true,
  );
}

function setSessionFields(
  database: Parameters<typeof removeTestRunner>[0]["database"],
  values: Partial<typeof agentSessions.$inferInsert>,
): void {
  const sessionIdCondition = eq(agentSessions.id, SESSION_ID);
  database
    .update(agentSessions)
    .set({ ...values })
    .where(sessionIdCondition)
    .run();
}

describe("session store runner reassignment", () => {
  test("reassigns only an owned runner-required session with a new path", () => {
    const { database, store } = runningStore();
    const replacementId = "018bcfe5-6800-7000-8000-000000000099";
    addReplacementRunner(database, replacementId);
    removeRunner(database, store);

    const before = store.get(TEST_USER_ID, SESSION_ID);
    expect(before?.turns).toHaveLength(1);
    expect(before?.turns?.[0]?.endedAt).not.toBeNull();
    expect(
      reassignSession(store, replacementId, "/replacement/project", {
        userId: "another-user",
      }),
    ).toEqual({ status: "not_found" });
    const reassigned = reassignSession(
      store,
      replacementId,
      "/replacement/project",
    );
    expect(reassigned.status).toBe("reassigned");
    expect(reassigned).toMatchObject({
      detail: {
        runnerId: replacementId,
        runnerRequired: false,
        status: "idle",
        workingDirectory: "/replacement/project",
      },
    });
    const after = store.get(TEST_USER_ID, SESSION_ID);
    expect(after?.messages).toEqual(before?.messages);
    expect(after?.costUsd).toBe(before?.costUsd);
    expect(after?.tools).toEqual(before?.tools);
    expect(store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 5).status).toBe(
      "queued",
    );
    closeHardeningDatabase({ database, store });
  });

  test("preserves stable spawned lineage while reassignment advances the child", () => {
    const { database, store } = runningStore();
    const parentId = "018bcfe5-6800-7000-8000-000000000098";
    const replacementId = "018bcfe5-6800-7000-8000-000000000099";
    addReplacementRunner(database, replacementId);
    setSessionFields(database, {
      parentCallbackGeneration: null,
      parentExecutionGeneration: 7,
      parentSessionId: parentId,
    });
    removeRunner(database, store);

    const reassigned = reassignSession(
      store,
      replacementId,
      "/replacement/project",
    );

    expect(reassigned).toMatchObject({
      detail: {
        generation: 2,
        parentExecutionGeneration: 7,
        parentSessionId: parentId,
        status: "idle",
      },
      status: "reassigned",
    });
    closeHardeningDatabase({ database, store });
  });

  test("rejects reassignment while a restart handoff is paused", () => {
    const { database, store } = runningStore();
    pauseRunningSessionForRestart(store);
    setSessionFields(database, { runnerRequired: true });
    const replacementId = "018bcfe5-6800-7000-8000-000000000099";
    addReplacementRunner(database, replacementId);
    const paused = requireSession(store, SESSION_ID);
    const before = { ...paused };

    expect(
      reassignSession(store, replacementId, "/replacement/project", {
        now: TEST_NOW + 3,
      }),
    ).toEqual({ status: "busy" });
    expect(store.get(TEST_USER_ID, SESSION_ID)).toEqual(before);
    closeHardeningDatabase({ database, store });
  });

  test("rejects a foreign or offline replacement inside the store transaction", () => {
    const { database, store } = runningStore();
    const foreignId = "018bcfe5-6800-7000-8000-000000000097";
    addForeignReplacementRunner(database, foreignId);
    const removed = removeTestRunner(
      { database, store },
      RUNNER_ID,
      TEST_NOW + 4,
    );
    expect(removed).toBe(true);

    expect(reassignSession(store, foreignId, "/foreign/project")).toEqual({
      status: "runner_unavailable",
    });
    expectStoredSession(store, SESSION_ID, {
      runnerId: RUNNER_ID,
      runnerRequired: true,
    });

    const offlineId = "018bcfe5-6800-7000-8000-000000000096";
    addReplacementRunner(database, offlineId);
    createRunnerStore(database).setOnline(
      offlineId,
      TEST_USER_ID,
      TEST_NOW + 5,
      false,
    );
    const offlineReassignment = reassignSession(
      store,
      offlineId,
      "/offline/project",
      { now: TEST_NOW + 5 },
    );
    expect(offlineReassignment).toEqual({ status: "runner_unavailable" });
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      runnerId: RUNNER_ID,
      runnerRequired: true,
    });
    closeHardeningDatabase({ database, store });
  });

  test("records the first unresolved model call once for parallel runner commands", () => {
    const setup = runningStore();
    const assistant = {
      content: "Running parallel work",
      role: "assistant" as const,
      toolCalls: [
        { arguments: "{}", id: "call-complete", name: "read" },
        { arguments: "{}", id: "call-parallel", name: "parallel" },
      ],
    };
    setup.store.appendCurrentAgentMessage(SESSION_ID, assistant, TEST_NOW + 2);
    setup.store.appendCurrentAgentMessage(
      SESSION_ID,
      {
        content: "done",
        role: "tool",
        toolCallId: "call-complete",
        toolName: "read",
      },
      TEST_NOW + 3,
    );

    setup.store.appendInterruptedRunnerTool(SESSION_ID, TEST_NOW + 4);

    const messages = setup.store.get(TEST_USER_ID, SESSION_ID)?.messages ?? [];
    const interrupted = messages.filter(
      ({ toolName }) => toolName === "parallel",
    );
    expect(interrupted).toEqual([
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-parallel",
        toolName: "parallel",
      }),
    ]);
    closeHardeningDatabase(setup);
  });

  test("atomically rejects create and queue after runner removal", () => {
    const { database, store } = idleHardeningStore();
    const before = fenceTestSession({ database, store }, RUNNER_ID);

    expect(
      store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 3, {
        content: "Do not append this stale request",
        images: [],
      }),
    ).toEqual({ status: "runner_required" });
    expectSessionUnchanged(store, SESSION_ID, before);
    assertUnavailableCreation(
      store,
      RUNNER_ID,
      "Do not create this stale session",
    );
    closeHardeningDatabase({ database, store });
  });

  test("atomically rejects a spawn after its runner is removed", () => {
    const { database, store } = runningStore();
    const removedChildRunnerId = "018bcfe5-6800-7000-8000-000000000095";
    addReplacementRunner(database, removedChildRunnerId);
    expect(
      removeTestRunner({ database, store }, removedChildRunnerId, TEST_NOW + 3),
    ).toBe(true);

    assertUnavailableCreation(
      store,
      removedChildRunnerId,
      "Do not create this spawned child",
      SESSION_ID,
    );
    closeHardeningDatabase({ database, store });
  });

  test("fences stopped sessions without clearing reassignment", () => {
    const { database, store } = idleHardeningStore();
    stopTestSession(store, SESSION_ID);
    removeAssignedTestRunner({ database, store }, RUNNER_ID);
    expectRecoverableStoppedSession(store, SESSION_ID);

    reassignTestSession({ database, store }, SESSION_ID);
    queueStoppedTestSession(store, SESSION_ID);
    closeHardeningDatabase({ database, store });
  });

  test("preserves reassignment when a fenced session is stopped", () => {
    const { database, store } = removedHardeningStore(RUNNER_ID);

    stopTestSession(store, SESSION_ID);
    closeStoppedSessionCycle({ database, store }, SESSION_ID);
  });

  test("rejects writes from the removed execution after reassignment", () => {
    const { database, store } = runningStore();
    const beforeRemoval = requireSession(store, SESSION_ID);
    removeAssignedTestRunner({ database, store }, RUNNER_ID);
    reassignTestSession({ database, store }, SESSION_ID, TEST_NOW + 3);
    const rejected = {
      before: store.get(TEST_USER_ID, SESSION_ID),
      setup: { database, store },
    };

    expectRejectedWrite(rejected, LATE_TOOL_MESSAGE, beforeRemoval.generation);
    closeHardeningDatabase({ database, store });
  });

  test("rejects every model message role after runner removal", () => {
    withRejectedWriteSetup(RUNNER_ID, (rejected) => {
      expectRejectedWrite(rejected, LATE_TOOL_MESSAGE);
    });
  });

  test("rejects model writes after runner removal", () => {
    withRejectedWriteSetup(RUNNER_ID, expectLateModelWritesRejected);
  });
});
