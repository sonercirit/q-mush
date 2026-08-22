import { expect, test, vi } from "vitest";
import { testAskQuestionsInput } from "./ask-questions-test-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  requireSpawnedChild,
  spawnedChildSetup,
  transitionSpawnedChild,
} from "./session-store-spawn-test-helpers.ts";
import {
  continueChild,
  deferredReportSetup,
  deliverDeferredReport,
  expectDurableReport,
  expectParentWake,
  idleParent,
  reportCount,
  setChildStatus,
  terminalEventActions,
} from "./session-terminal-event-test-helpers.ts";

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

type DeferredParentCase = {
  arrange: (context: ReturnType<typeof deferredReportSetup>) => unknown;
  assertParent: (
    context: ReturnType<typeof deferredReportSetup>,
    arranged: unknown,
  ) => void;
  name: string;
  overrides?: Parameters<typeof deferredReportSetup>[0];
};

const deferredParentCases: DeferredParentCase[] = [
  ...(["paused", "stopped", "failed"] as const).map((status) => ({
    arrange: ({ setup }) =>
      setChildStatus({ ...setup, childId: setup.parentId }, status),
    assertParent: ({ setup }) => {
      expect(setup.store.get(TEST_USER_ID, setup.parentId)?.status).toBe(
        status,
      );
    },
    name: `a deferred report does not launch a ${status} parent and remains durable`,
  })),
  ...(
    [
      ["active execution", { activeSession: () => true }],
      ["unavailable runner", { runnerIsAvailable: () => false }],
    ] as const
  ).map(([state, overrides]) => ({
    arrange: ({ setup }) => idleParent(setup),
    assertParent: ({ setup }) => {
      expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
        generation: setup.parentGeneration,
        status: "idle",
      });
    },
    name: `a deferred report does not launch an idle parent with ${state}`,
    overrides,
  })),
  {
    arrange: ({ setup }) => {
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
    },
    assertParent: ({ setup }) => {
      expect(
        setup.store.get(TEST_USER_ID, setup.parentId)?.restartHandoff,
      ).not.toBeNull();
    },
    name: "a deferred report does not launch a restart-draining parent",
  },
  {
    arrange: ({ setup }) => {
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
      return pending.id;
    },
    assertParent: ({ setup }, pendingId) => {
      expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
        pendingQuestions: { id: pendingId },
        status: "idle",
      });
    },
    name: "a deferred report does not consume the event while the parent awaits input",
  },
];

test.each(deferredParentCases)(
  "$name",
  async ({ arrange, assertParent, overrides }) => {
    const context = deferredReportSetup(overrides);
    const arranged = arrange(context);

    await deliverDeferredReport(context.setup, context.delivery);

    expectDurableReport(context.setup, context.delivery);
    assertParent(context, arranged);
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
