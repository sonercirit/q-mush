import { expect, test, vi } from "vitest";
import { testAskQuestionsInput } from "./ask-questions-test-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  expectParentWake,
  idleParent,
  reportCount,
  setChildStatus,
  terminalEventActions,
} from "./session-child-terminal-events.test.ts";
import { requireSpawnedChild } from "./session-store-result-helpers.ts";
import {
  spawnedChildSetup,
  transitionSpawnedChild,
} from "./session-store-spawn-test-helpers.ts";

test("stopping a child wakes a runnable idle parent and consumes its report", async () => {
  const setup = spawnedChildSetup();
  const continued = continueChild(setup);
  transitionSpawnedChild(setup, continued.generation, TEST_NOW + 7);
  idleParent(setup);
  const delivery = terminalEventActions(setup.store, setup.database);
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  if (parent === undefined) throw new Error("Stopped child parent unavailable");

  delivery.actions.stopChildren(parent, TEST_USER_ID);

  await expectParentWake(setup, delivery);
  expect(reportCount(setup.store, setup.parentId)).toBe(2);
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
});

test("stopping children notifies the parent after delivering the stop report", () => {
  const setup = spawnedChildSetup();
  const delivery = terminalEventActions(setup.store, setup.database);
  const continued = continueChild(setup);
  transitionSpawnedChild(setup, continued.generation, TEST_NOW + 7);
  expect(delivery.launchSession).not.toHaveBeenCalled();
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  expect(parent).toMatchObject({ id: setup.parentId });
  if (parent === undefined) throw new Error("Stopped child parent unavailable");

  expect(continued.id).toBe(setup.childId);
  delivery.actions.stopChildren(parent, TEST_USER_ID);

  expect(delivery.notify).toHaveBeenCalledWith(TEST_USER_ID, setup.childId);
  expect(delivery.abortSession).toHaveBeenCalledWith(setup.childId);
  expect(delivery.cancelSessionCommands).toHaveBeenCalledWith(setup.childId);
  expect(delivery.cleanupSession).toHaveBeenCalledWith(
    expect.objectContaining({ id: setup.childId }),
  );
  expect(delivery.launchSession.mock.calls).toEqual([]);
  expect(delivery.notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
});

test.each(["paused", "stopped", "failed"] as const)(
  "a deferred report does not launch a %s parent and remains durable",
  async (status) => {
    const setup = spawnedChildSetup();
    const delivery = terminalEventActions(setup.store, setup.database);
    delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);
    setChildStatus({ ...setup, childId: setup.parentId }, status);

    delivery.actions.reportedParent(
      { disposition: "deferred", parentId: setup.parentId },
      TEST_USER_ID,
    );
    await Promise.resolve();

    expect(delivery.launchSession).not.toHaveBeenCalled();
    expect(reportCount(setup.store, setup.parentId)).toBe(1);
    expect(setup.store.get(TEST_USER_ID, setup.parentId)?.status).toBe(status);
  },
);

test.each([
  ["active execution", { activeSession: () => true }],
  ["unavailable runner", { runnerIsAvailable: () => false }],
] as const)(
  "a deferred report does not launch an idle parent with %s",
  async (_state, overrides) => {
    const setup = spawnedChildSetup();
    const delivery = terminalEventActions(
      setup.store,
      setup.database,
      vi.fn(),
      overrides,
    );
    delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);
    idleParent(setup);

    delivery.actions.reportedParent(
      { disposition: "deferred", parentId: setup.parentId },
      TEST_USER_ID,
    );
    await Promise.resolve();

    expect(delivery.launchSession).not.toHaveBeenCalled();
    expect(reportCount(setup.store, setup.parentId)).toBe(1);
    expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
      generation: setup.parentGeneration,
      status: "idle",
    });
  },
);

test("a manual resume racing the deferred wake consumes one report in one attempt", async () => {
  const setup = spawnedChildSetup();
  idleParent(setup);
  const delivery = terminalEventActions(setup.store, setup.database);
  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);

  delivery.actions.reportedParent(
    { disposition: "deferred", parentId: setup.parentId },
    TEST_USER_ID,
  );
  const manual = setup.store.queue(TEST_USER_ID, setup.parentId, TEST_NOW + 10);
  await vi.waitFor(() => {
    const parent = setup.store.get(TEST_USER_ID, setup.parentId);
    expect(parent).toMatchObject({
      generation: setup.parentGeneration + 1,
      status: "queued",
    });
  });

  expect(["busy", "queued"]).toContain(manual.status);
  expect(delivery.launchSession.mock.calls.length).toBeLessThanOrEqual(1);
  expect(reportCount(setup.store, setup.parentId)).toBe(1);
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
});

test("a deferred report does not launch a restart-draining parent", async () => {
  const setup = spawnedChildSetup();
  const delivery = terminalEventActions(setup.store, setup.database);
  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);
  setup.database.$client
    .query(
      "UPDATE agent_sessions SET status = 'idle', restart_handoff = ? WHERE id = ?",
    )
    .run(
      JSON.stringify({
        executionGeneration: setup.parentGeneration,
        operation: "agent",
        pendingInput: [],
        requestedBy: "server",
        restartId: "deferred-report-drain",
      }),
      setup.parentId,
    );

  delivery.actions.reportedParent(
    { disposition: "deferred", parentId: setup.parentId },
    TEST_USER_ID,
  );
  await Promise.resolve();

  expect(delivery.launchSession).not.toHaveBeenCalled();
  expect(reportCount(setup.store, setup.parentId)).toBe(1);
  expect(
    setup.store.get(TEST_USER_ID, setup.parentId)?.restartHandoff,
  ).not.toBeNull();
});

test("a deferred report does not consume the event while the parent awaits input", async () => {
  const setup = spawnedChildSetup();
  const delivery = terminalEventActions(setup.store, setup.database);
  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  if (parent === undefined) throw new Error("Question parent unavailable");
  const pending = setup.store
    .questions()
    .create(
      TEST_USER_ID,
      parent.id,
      parent.generation,
      "parent-question",
      testAskQuestionsInput(),
      TEST_NOW + 8,
    );
  idleParent(setup);

  delivery.actions.reportedParent(
    { disposition: "deferred", parentId: setup.parentId },
    TEST_USER_ID,
  );
  await Promise.resolve();

  expect(delivery.launchSession).not.toHaveBeenCalled();
  expect(reportCount(setup.store, setup.parentId)).toBe(1);
  expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
    pendingQuestions: { id: pending.id },
    status: "idle",
  });
});
