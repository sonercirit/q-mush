import { expect, test, vi } from "vitest";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { SessionAgentActions } from "../session-agent-actions.ts";
import { SessionStore } from "../session-store.ts";
import {
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  spawnedParentReports,
  terminalEventActionSetup,
} from "./session-race-test-helpers.ts";
import { requireCreatedSession } from "./session-store-result-helpers.ts";
import {
  closeSpawnedChildSetup,
  completeSpawnedChildGeneration,
  continueSpawnedChild,
  expectNoPendingSpawnedSessions,
  requireSpawnedChild,
  spawnedChildSetup,
  terminalRecordedMessage,
  transitionSpawnedChild,
} from "./session-store-spawn-test-helpers.ts";
import {
  emptyRuntimes,
  testSessionInput,
} from "./session-store-test-fixtures.ts";

function parentReports(
  store: SessionStore,
  parentId: string,
): readonly string[] {
  return spawnedParentReports(store, parentId);
}

function continueChild(setup: ReturnType<typeof spawnedChildSetup>) {
  return continueSpawnedChild(setup, TEST_NOW + 6);
}

function terminalEventActions(
  store: SessionStore,
  database: ConstructorParameters<typeof SessionStore>[0],
) {
  const launchSession = vi.fn(() => true);
  const notify = vi.fn();
  const actions = new SessionAgentActions(
    terminalEventActionSetup({ database, store }, launchSession, notify),
  );
  return { actions, launchSession, notify };
}

function reportCount(store: SessionStore, parentId: string): number {
  return parentReports(store, parentId).filter((content) =>
    content.startsWith("Spawned session "),
  ).length;
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
  closeSpawnedChildSetup(setup);
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
  closeSpawnedChildSetup(setup);
});

test("idle parents persist sibling events and surface them on next resume", async () => {
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
      ? resumed.detail.messages.filter(({ content }) =>
          content.startsWith("Spawned session "),
        )
      : [],
  ).toHaveLength(2);
  expect(
    resumed.status === "queued"
      ? resumed.detail.messages.some(
          ({ content, role }) =>
            role === "user" && content === "Continue with my request",
        )
      : false,
  ).toBe(true);

  const reports = parentReports(setup.store, setup.parentId);
  expect(reportCount(setup.store, setup.parentId)).toBe(2);
  expect(reports.join("\n")).toContain(setup.childId);
  expect(reports.join("\n")).toContain(siblingId);
  expect(notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
  expect(setup.store.get(TEST_USER_ID, setup.parentId)?.status).toBe("queued");
  await Promise.resolve();
  closeSpawnedChildSetup(setup);
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
  });
  closeSpawnedChildSetup(setup);
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
  closeSpawnedChildSetup(setup);
});

test("stopping children notifies the parent after delivering the stop report", () => {
  const setup = spawnedChildSetup();
  const delivery = terminalEventActions(setup.store, setup.database);
  const continued = continueChild(setup);
  transitionSpawnedChild(setup, continued.generation, TEST_NOW + 7);
  expect(delivery.launchSession).not.toHaveBeenCalled();
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  expect(parent).toMatchObject({ id: setup.parentId });
  if (parent === undefined) {
    throw new Error("Stopped child parent unavailable");
  }

  expect(continued.id).toBe(setup.childId);
  delivery.actions.stopChildren(parent, TEST_USER_ID);

  expect(delivery.notify).toHaveBeenCalledWith(TEST_USER_ID, setup.childId);
  expect(delivery.launchSession.mock.calls).toEqual([]);
  expect(delivery.notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
  closeSpawnedChildSetup(setup);
});

test.each(["completed", "failed", "stopped"] as const)(
  "terminal %s attempts persist an authorized parent event",
  (status) => {
    const setup = spawnedChildSetup();
    setup.database.$client
      .query("UPDATE agent_sessions SET status = ? WHERE id = ?")
      .run(status, setup.childId);

    const detail = requireSpawnedChild(setup);
    const { actions, notify } = terminalEventActions(
      setup.store,
      setup.database,
    );
    actions.reportOne(detail, TEST_USER_ID);

    const reports = parentReports(setup.store, setup.parentId);
    expect(reports).toContainEqual(
      expect.stringContaining(`Spawned session ${status}`),
    );
    expect(reports).toContainEqual(expect.stringContaining(setup.childId));
    expect(notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
    expectNoPendingSpawnedSessions(setup);
    closeSpawnedChildSetup(setup);
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
  closeSpawnedChildSetup(setup);
});
