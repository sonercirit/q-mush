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
  continuedChildSetup,
  deferredReportSetup,
  deliverDeferredReport,
  expectConsumedReports,
  expectDurableReport,
  expectParentWake,
  expectQueuedParentState,
  idleParent,
  idleParentDeliverySetup,
  parentState,
  reportParentDisposition,
  requireParent,
  setChildStatus,
  terminalEventActions,
} from "./session-terminal-event-test-helpers.ts";

test("stopping a child wakes a runnable idle parent and consumes its report", async () => {
  const { continued, setup } = continuedChildSetup();
  transitionSpawnedChild(setup, continued.generation, TEST_NOW + 7);
  idleParent(setup);
  const delivery = terminalEventActions(setup.store, setup.database);
  const parent = requireParent(setup);

  delivery.actions.stopChildren(parent, TEST_USER_ID);

  await expectParentWake(setup, delivery);
  expectConsumedReports(setup, 2);
});

test("stopping children notifies the parent after delivering the stop report", () => {
  const setup = spawnedChildSetup();
  const delivery = terminalEventActions(setup.store, setup.database);
  const continued = continueChild(setup);
  transitionSpawnedChild(setup, continued.generation, TEST_NOW + 7);
  expect(delivery.launchSession).not.toHaveBeenCalled();
  const parent = requireParent(setup);
  expect(parent).toMatchObject({ id: setup.parentId });

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

type DeferredParentContext = ReturnType<typeof deferredReportSetup>;

interface DeferredParentCase {
  arrange: (context: DeferredParentContext) => unknown;
  assertParent: (context: DeferredParentContext, arranged: unknown) => void;
  name: string;
  overrides?: Parameters<typeof deferredReportSetup>[0];
}

const deferredParentCases: DeferredParentCase[] = [
  ...(["paused", "stopped", "failed"] as const).map((status) => {
    const arrange = ({ setup }: DeferredParentContext): void => {
      setChildStatus({ ...setup, childId: setup.parentId }, status);
    };
    return {
      arrange,
      assertParent: ({ setup }: DeferredParentContext) => {
        expect(parentState(setup)?.status).toBe(status);
      },
      name: `a deferred report does not launch a ${status} parent and remains durable`,
    };
  }),
  ...(
    [
      ["active execution", { activeSession: () => true }],
      ["unavailable runner", { runnerIsAvailable: () => false }],
    ] as const
  ).map(([state, overrides]) => ({
    arrange: ({ setup }: DeferredParentContext) => {
      idleParent(setup);
    },
    assertParent: ({ setup }: DeferredParentContext) => {
      expect(parentState(setup)).toMatchObject({
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
      expect(parentState(setup)?.restartHandoff).not.toBeNull();
    },
    name: "a deferred report does not launch a restart-draining parent",
  },
  {
    arrange: ({ setup }) => {
      const parent = requireParent(setup);
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
      expect(parentState(setup)).toMatchObject({
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
  const { delivery, setup } = idleParentDeliverySetup();
  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);

  reportParentDisposition(setup, delivery, "deferred");
  const manual = setup.store.queue(TEST_USER_ID, setup.parentId, TEST_NOW + 10);
  await vi.waitFor(() => {
    expectQueuedParentState(setup);
  });

  expect(["busy", "queued"]).toContain(manual.status);
  expect(delivery.launchSession.mock.calls.length).toBeLessThanOrEqual(1);
  expectConsumedReports(setup, 1);
});
