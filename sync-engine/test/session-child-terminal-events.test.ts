import { expect, test, vi } from "vitest";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { type SessionAgentActions } from "../session-agent-actions.ts";
import { SessionStore } from "../session-store.ts";
import { testAskQuestionsInput } from "./ask-questions-test-fixtures.ts";
import {
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { spawnedParentReports } from "./session-race-test-helpers.ts";
import { requireCreatedSession } from "./session-store-result-helpers.ts";
import {
  completeSpawnedChildGeneration,
  expectNoPendingSpawnedSessions,
  requireSpawnedChild,
  spawnedChildSetup,
  spawnedRunningChildSetup,
  terminalRecordedMessage,
  transitionSpawnedChild,
} from "./session-store-spawn-test-helpers.ts";
import {
  emptyRuntimes,
  testSessionInput,
} from "./session-store-test-fixtures.ts";
import {
  continueChild,
  expectConsumedReportCount,
  expectConsumedReports,
  expectParentWake,
  idleParentDeliverySetup,
  reportCount,
  reportPendingDelivery,
  setChildStatus,
  terminalEventActions,
} from "./session-terminal-event-test-helpers.ts";

function parentReports(
  store: SessionStore,
  parentId: string,
): readonly string[] {
  return spawnedParentReports(store, parentId);
}

function reportPendingTwice(
  actions: SessionAgentActions,
  store: SessionStore,
): void {
  actions.reportAll(store.pendingSpawnedSessions());
  actions.reportAll(store.pendingSpawnedSessions());
}

function forceObservedIdleSettlement(
  setup: ReturnType<typeof spawnedChildSetup>,
  status: "idle" | "paused" = "idle",
): void {
  // Reproduce the production settlement defect: a linked generation has a
  // durable final assistant response but remains continuable/idle.
  setChildStatus(setup, status);
}

function deliverIdleAttempt(
  setup: ReturnType<typeof spawnedChildSetup>,
  eventActions: ReturnType<typeof terminalEventActions>,
): void {
  forceObservedIdleSettlement(setup);
  reportPendingTwice(eventActions.actions, setup.store);
}

function joinedParentReports(
  setup: ReturnType<typeof spawnedChildSetup>,
): string {
  return parentReports(setup.store, setup.parentId).join("\n");
}

function expectReportTotals(
  setup: ReturnType<typeof spawnedChildSetup>,
  notify: ReturnType<typeof vi.fn>,
  total: number,
): void {
  expectConsumedReportCount(setup, total);
  expect(notify).toHaveBeenCalledTimes(total);
}

function reportAllPending(
  setup: ReturnType<typeof spawnedChildSetup>,
  actions: SessionAgentActions,
): void {
  actions.reportAll(setup.store.pendingSpawnedSessions());
}

function expectNoParentReport(
  setup: ReturnType<typeof spawnedChildSetup>,
  pending: number,
): void {
  expect(joinedParentReports(setup)).not.toContain("Spawned session ");
  expect(setup.store.pendingSpawnedSessions()).toHaveLength(pending);
}

function expectAttemptFilteredFromParentReports(
  setup: ReturnType<typeof spawnedChildSetup>,
  actions: SessionAgentActions,
): void {
  reportAllPending(setup, actions);
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
  expect(reportCount(setup.store, setup.parentId)).toBe(0);
}

function completeSibling(
  setup: ReturnType<typeof spawnedChildSetup>,
  content: string,
): string {
  const detail = requireCreatedSession(
    setup.store.create(
      testSessionInput({
        parentGeneration: setup.parentGeneration,
        parentSessionId: setup.parentId,
        prompt: content,
      }),
      TEST_NOW + 5,
    ),
    "The sibling child could not be created",
  );
  expect(
    setup.store.transitionRuntime(
      detail.id,
      "running",
      TEST_NOW + 6,
      detail.generation,
    ),
  ).toBe(true);
  setup.store.commitRuntimeTerminal(
    detail.id,
    [terminalRecordedMessage(content)],
    TEST_NOW + 7,
    detail.generation,
    null,
  );
  return detail.id;
}

function compactRunningParent(
  store: SessionStore,
  parentId: string,
  parentGeneration: number,
): void {
  store.compactRuntimeConversation(
    parentId,
    "The parent compacted while waiting for child work.",
    { contextTokens: 100, costBasis: "reported", costUsd: 0 },
    TEST_NOW + 8,
    parentGeneration,
    TEST_NOW + 7,
  );
}

function runningChildWithoutCallback() {
  const setup = spawnedRunningChildSetup("independent runtime generations");
  const child = requireSpawnedChild(setup);
  setup.database.$client
    .query(
      "UPDATE agent_sessions SET parent_callback_generation = NULL WHERE id = ?",
    )
    .run(child.id);
  return { child, setup };
}

test("runtime terminal settlement uses the callback generation independently", () => {
  const { child, setup } = runningChildWithoutCallback();

  setup.store.commitRuntimeTerminal(
    child.id,
    [terminalRecordedMessage("independent terminal")],
    TEST_NOW + 6,
    child.generation,
    null,
  );

  expect(setup.store.get(TEST_USER_ID, child.id)).toMatchObject({
    parentExecutionGeneration: setup.parentGeneration,
    status: "idle",
  });
});

test("continued child generations retain the parent delivery route", () => {
  const setup = spawnedChildSetup();
  const continued = continueChild(setup);

  expect(continued.parentExecutionGeneration).toBe(setup.parentGeneration);
  completeSpawnedChildGeneration(
    setup,
    continued.generation,
    "generation one",
    TEST_NOW + 7,
  );

  expect(setup.store.pendingSpawnedSessions()).toMatchObject([
    {
      detail: {
        generation: continued.generation,
        id: setup.childId,
        status: "completed",
      },
      userId: TEST_USER_ID,
    },
  ]);
});

test("durable generation events survive recreation, compaction, and duplicate scans", () => {
  const setup = spawnedChildSetup();
  const firstGeneration = setup.childGeneration;
  const continued = continueChild(setup);
  expect(parentReports(setup.store, setup.parentId)).toContainEqual(
    expect.stringContaining("Child terminal assistant message"),
  );
  expect(
    setup.store.appendSpawnedSessionReport(
      TEST_USER_ID,
      setup.childId,
      firstGeneration,
      setup.parentId,
      setup.parentGeneration,
      "duplicate first event",
      TEST_NOW + 6,
    ),
  ).toBe(false);

  transitionSpawnedChild(setup, continued.generation, TEST_NOW + 7);
  setup.store.settleRuntimeFailure(
    setup.childId,
    "Session failed: credential_rate_limited token=super-secret-value",
    TEST_NOW + 8,
    continued.generation,
  );
  compactRunningParent(setup.store, setup.parentId, setup.parentGeneration);

  const recreated = new SessionStore(
    setup.database,
    () => "recreated-child-event-message",
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
  );
  const { actions, launchSession, notify } = terminalEventActions(
    recreated,
    setup.database,
  );
  actions.reportAll(recreated.pendingSpawnedSessions());
  actions.reportAll(recreated.pendingSpawnedSessions());

  const reports = parentReports(recreated, setup.parentId);
  const continuedReports = reports.filter(
    (content) =>
      content.includes(setup.childId) &&
      content.includes(`"generation": ${String(continued.generation)}`),
  );
  expect(continuedReports).toHaveLength(1);
  expect(continuedReports[0]).toContain('"status": "failed"');
  expect(continuedReports[0]).toContain(
    "credential_rate_limited token=[redacted]",
  );
  expect(reports.join("\n")).not.toContain("super-secret-value");
  expect(recreated.pendingSpawnedSessions()).toEqual([]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
  expect(launchSession).not.toHaveBeenCalled();
});

test("startup reporting wakes an idle parent for a deferred durable event", async () => {
  const { delivery, setup } = idleParentDeliverySetup();

  reportPendingDelivery(setup, delivery);

  await expectParentWake(setup, delivery);
  expectConsumedReports(setup, 1);
});

test("idle parents persist sibling events and surface them on next resume", () => {
  const setup = spawnedChildSetup();
  const siblingId = completeSibling(setup, "Sibling terminal result");
  expect(
    setup.store.transitionRuntime(
      setup.parentId,
      "idle",
      TEST_NOW + 8,
      setup.parentGeneration,
    ),
  ).toBe(true);
  const { actions, launchSession, notify } = terminalEventActions(
    setup.store,
    setup.database,
  );
  actions.reportAll(setup.store.pendingSpawnedSessions());
  expect(launchSession).not.toHaveBeenCalled();
  const resumed = setup.store.queue(
    TEST_USER_ID,
    setup.parentId,
    TEST_NOW + 10,
    { content: "Continue with my request", images: [] },
  );
  expect(resumed.status).toBe("queued");
  expect(
    resumed.status === "queued"
      ? resumed.detail.messages.some(
          ({ content, role }) =>
            role === "user" && content === "Continue with my request",
        )
      : false,
  ).toBe(true);
  expect(
    resumed.status === "queued"
      ? resumed.detail.messages.filter(({ content }) =>
          content.startsWith("Spawned session "),
        )
      : [],
  ).toHaveLength(2);

  const reports = parentReports(setup.store, setup.parentId);
  const joinedReports = reports.join("\n");
  expectConsumedReportCount(setup, 2);
  expect(joinedReports).toContain(setup.childId);
  expect(joinedReports).toContain(siblingId);
  expect(notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
  expect(setup.store.get(TEST_USER_ID, setup.parentId)?.status).toBe("queued");
});

test("runner parent reports notify and wake the delivered parent", async () => {
  const setup = spawnedChildSetup();
  setup.database.$client
    .query("UPDATE agent_sessions SET status = 'idle' WHERE id = ?")
    .run(setup.parentId);
  const delivery = terminalEventActions(setup.store, setup.database);

  delivery.actions.reportedParent(
    { disposition: "delivered", parentId: setup.parentId },
    TEST_USER_ID,
  );

  expect(delivery.notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
  await vi.waitFor(() => {
    expect(delivery.launchSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: setup.parentId }),
      TEST_USER_ID,
    );
    expect(delivery.notify).toHaveBeenCalledTimes(2);
    const queuedParent = setup.store.get(TEST_USER_ID, setup.parentId);
    expect(queuedParent).toMatchObject({ status: "queued" });
  });
  await vi.waitFor(() => {
    expect(delivery.launchSession).toHaveBeenCalledTimes(1);
  });
});

test("a report to a terminal parent notifies the child route", () => {
  const setup = spawnedChildSetup();
  const terminalParent = setup.parentId;
  setup.database.$client
    .query("UPDATE agent_sessions SET status = 'completed' WHERE id = ?1")
    .run(terminalParent);
  const delivery = terminalEventActions(setup.store, setup.database);
  expect(delivery.launchSession).not.toHaveBeenCalled();

  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);

  expect(delivery.notify).toHaveBeenNthCalledWith(
    1,
    TEST_USER_ID,
    setup.childId,
  );
  expect(delivery.launchSession).not.toHaveBeenCalled();
  expect(delivery.notify).not.toHaveBeenCalledWith(
    TEST_USER_ID,
    setup.parentId,
  );
});

test.each(["completed", "failed", "idle", "stopped"] as const)(
  "settled %s attempts persist an authorized parent event",
  (status) => {
    const setup = spawnedChildSetup();
    setChildStatus(setup, status);

    const detail = requireSpawnedChild(setup);
    const { actions, notify } = terminalEventActions(
      setup.store,
      setup.database,
    );
    actions.reportOne(detail, TEST_USER_ID);

    const parentEvent = parentReports(setup.store, setup.parentId).find(
      (content) => content.includes(setup.childId),
    );
    expect(parentEvent).toContain(`Spawned session ${status}`);
    expect(parentEvent).toContain(`"status": "${status}"`);
    expect(notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
    expectNoPendingSpawnedSessions(setup);
  },
);

test("foreign owners cannot discover or claim a child event", () => {
  const setup = spawnedChildSetup();

  expect(
    setup.store.spawnedSessionLink(TEST_FOREIGN_USER_ID, setup.childId),
  ).toBeUndefined();
  expect(
    setup.store.appendSpawnedSessionReport(
      TEST_FOREIGN_USER_ID,
      setup.childId,
      setup.childGeneration,
      setup.parentId,
      setup.parentGeneration,
      "foreign event",
      TEST_NOW + 5,
    ),
  ).toBe(false);
  expect(setup.store.pendingSpawnedSessions()).toHaveLength(1);
  expect(parentReports(setup.store, setup.parentId)).not.toContain(
    "foreign event",
  );
});

test("continued idle child attempts each deliver exactly once", () => {
  const setup = spawnedChildSetup();
  const eventActions = terminalEventActions(setup.store, setup.database);
  deliverIdleAttempt(setup, eventActions);

  expectReportTotals(setup, eventActions.notify, 1);
  expect(joinedParentReports(setup)).toContain('"status": "idle"');
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);

  setChildStatus(setup, "completed");
  const replayStore = new SessionStore(
    setup.database,
    () => "idle-event-replay-message",
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
  );
  const replay = terminalEventActions(replayStore, setup.database);
  replay.actions.reportAll(replayStore.pendingSpawnedSessions());
  expect(replay.notify).not.toHaveBeenCalled();
  expectReportTotals(setup, eventActions.notify, 1);

  const continued = continueChild(setup);
  completeSpawnedChildGeneration(
    setup,
    continued.generation,
    "later idle final",
    TEST_NOW + 7,
  );
  deliverIdleAttempt(setup, eventActions);

  expectReportTotals(setup, eventActions.notify, 2);
  expect(joinedParentReports(setup)).toContain("later idle final");
});

test("an idle generation lacking its final assistant response stays unreported", () => {
  const setup = spawnedRunningChildSetup("final response removed");
  const child = requireSpawnedChild(setup);
  setup.database.$client
    .query("DELETE FROM agent_messages WHERE session_id = ? AND role = ?")
    .run(child.id, "assistant");
  forceObservedIdleSettlement(setup);
  const eventActions = terminalEventActions(setup.store, setup.database);
  expectAttemptFilteredFromParentReports(setup, eventActions.actions);
});

test("a tool-calling idle response remains an unfinished attempt", () => {
  const setup = spawnedRunningChildSetup("assistant called a tool");
  const child = requireSpawnedChild(setup);
  setup.database.$client
    .query(
      "UPDATE agent_messages SET tool_calls = ? WHERE session_id = ? AND role = ?",
    )
    .run(
      JSON.stringify([
        { arguments: "{}", id: "unfinished-call", name: "read" },
      ]),
      child.id,
      "assistant",
    );
  forceObservedIdleSettlement(setup);
  const { actions } = terminalEventActions(setup.store, setup.database);
  expectAttemptFilteredFromParentReports(setup, actions);
});

test("idle child attempts waiting for question input are not final", () => {
  const setup = spawnedRunningChildSetup(
    "Ask before choosing an implementation",
  );
  const child = requireSpawnedChild(setup);
  const pending = setup.store
    .questions()
    .create(
      TEST_USER_ID,
      child.id,
      child.generation,
      "call-question",
      testAskQuestionsInput(),
      TEST_NOW + 4,
    );
  setChildStatus(setup, "idle");
  const idle = setup.store.get(TEST_USER_ID, child.id);
  const { actions } = terminalEventActions(setup.store, setup.database);
  reportAllPending(setup, actions);

  expect(idle).toMatchObject({
    pendingQuestions: { id: pending.id },
    status: "idle",
  });
  expectNoParentReport(setup, 0);
});
