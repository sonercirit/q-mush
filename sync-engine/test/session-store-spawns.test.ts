import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  expectParentId,
  spawnedChildSetup,
  type SpawnedChildReference,
} from "./session-store-spawn-test-helpers.ts";
import {
  createStore,
  createTestSession,
  testSessionInput,
} from "./session-store-test-fixtures.ts";

function report(setup: SpawnedChildReference, now = TEST_NOW + 5): boolean {
  return setup.store.appendSpawnedSessionReport(
    TEST_USER_ID,
    setup.childId,
    setup.childGeneration,
    setup.parentId,
    setup.parentGeneration,
    "Child complete",
    now,
  );
}

function updateGeneration(
  setup: SpawnedChildReference,
  target: "child" | "parent",
): void {
  const id = target === "child" ? setup.childId : setup.parentId;
  const generation =
    target === "child" ? setup.childGeneration : setup.parentGeneration;
  setup.database
    .update(agentSessions)
    .set({ executionGeneration: generation + 1 })
    .where(eq(agentSessions.id, id))
    .run();
}

function expectReportDisposition(
  setup: SpawnedChildReference,
  claimed: boolean,
  now = TEST_NOW + 5,
): void {
  expect(report(setup, now)).toBe(claimed);
  if (claimed) expect(spawnedLink(setup)).toBeUndefined();
  else expectParentId(setup);
}

function expectReportClaimed(
  setup: SpawnedChildReference,
  now = TEST_NOW + 5,
): void {
  expectReportDisposition(setup, true, now);
}

function expectRetainedReport(
  setup: SpawnedChildReference,
  now = TEST_NOW + 5,
): void {
  expectReportDisposition(setup, false, now);
}

function spawnedLink(setup: SpawnedChildReference) {
  return setup.store.spawnedSessionLink(TEST_USER_ID, setup.childId);
}

function closeSetup(setup: SpawnedChildReference): void {
  setup.database.$client.close();
}

function closeAfterParentAssertion(
  setup: SpawnedChildReference,
  assertion: (
    parent: ReturnType<SpawnedChildReference["store"]["get"]>,
  ) => void,
): void {
  assertion(setup.store.get(TEST_USER_ID, setup.parentId));
  closeSetup(setup);
}

function expectedPendingReport(setup: SpawnedChildReference) {
  return {
    clientRequestId: `spawn:${setup.childId}:${String(setup.childGeneration)}`,
    content: "Child complete",
    kind: "steer",
  } as const;
}

function childSummary(setup: SpawnedChildReference) {
  return setup.store.list(TEST_USER_ID).find((session) => {
    return session.id === setup.childId;
  });
}

function expectNoPendingReports(setup: SpawnedChildReference): void {
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
}

describe("spawned session report generation fencing", () => {
  test("allows a user-initiated child from an idle current parent", () => {
    const setup = createStore();
    const parent = createTestSession(setup.store);
    const child = setup.store.create(
      testSessionInput({
        parentGeneration: parent.generation,
        parentSessionId: parent.id,
        parentUserInitiated: true,
        prompt: "User-selected child tools",
        tools: ["read"],
      }),
      TEST_NOW + 1,
    );

    expect(child.status).toBe("created");
    expect(child.status === "created" ? child.detail.tools : []).toEqual([
      "read",
    ]);
    setup.database.$client.close();
  });

  test("persists and claims the current parent callback", () => {
    const setup = spawnedChildSetup();
    const childDetail = setup.store.get(TEST_USER_ID, setup.childId);

    expect(setup.store.pendingSpawnedSessions()).toEqual([
      { detail: childDetail, userId: TEST_USER_ID },
    ]);
    expectReportClaimed(setup);
    expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
      pendingInputs: [expectedPendingReport(setup)],
      status: "running",
    });
    expect(childSummary(setup)?.parentSessionId).toBe(setup.parentId);
    expectNoPendingReports(setup);
    expect(
      setup.store.settleNormalBoundary(
        setup.parentId,
        TEST_NOW + 6,
        setup.parentGeneration,
      ),
    ).toEqual({ status: "queued", userId: TEST_USER_ID });
    expect(childSummary(setup)?.parentExecutionGeneration).toBeNull();
    closeAfterParentAssertion(setup, (parent) => {
      expect(parent?.messages.at(-1)?.content).toBe("Child complete");
    });
  });

  test("does not enqueue a duplicate callback", () => {
    const setup = spawnedChildSetup();

    expectReportClaimed(setup);
    expect(report(setup, TEST_NOW + 6)).toBe(false);
    expect(
      setup.store.get(TEST_USER_ID, setup.parentId)?.pendingInputs,
    ).toMatchObject([expectedPendingReport(setup)]);
    closeSetup(setup);
  });

  test.each(["parent", "child"] as const)(
    "retains the callback when the %s generation changes",
    (target) => {
      const setup = spawnedChildSetup();
      updateGeneration(setup, target);

      expectRetainedReport(setup);
      if (target === "parent") {
        const parent = setup.store.get(TEST_USER_ID, setup.parentId);
        const parentHasReport = parent?.messages.some(
          (message) => message.content === "Child complete",
        );
        expect(parentHasReport).toBe(false);
      }
      closeSetup(setup);
    },
  );

  test("delivers the callback to a stopped parent", () => {
    const setup = spawnedChildSetup();
    expect(setup.store.stop(TEST_USER_ID, setup.parentId, TEST_NOW + 5)).toBe(
      true,
    );

    expectReportClaimed(setup, TEST_NOW + 6);
    closeAfterParentAssertion(setup, (parent) => {
      expect(
        parent?.messages.some(({ content }) => content === "Child complete"),
      ).toBe(true);
      expect(parent).toMatchObject({ pendingInputs: [], status: "stopped" });
    });
  });

  test("keeps completed hierarchy links without scheduling another callback", () => {
    const setup = spawnedChildSetup();

    expectReportClaimed(setup);
    expect(
      setup.store.spawnedSessionChildren(TEST_USER_ID, setup.parentId),
    ).toEqual([setup.childId]);
    expect(childSummary(setup)).toMatchObject({
      parentExecutionGeneration: null,
      parentSessionId: setup.parentId,
    });
    closeSetup(setup);
  });

  test("does not expose historical links without a generation", () => {
    const setup = spawnedChildSetup();
    setup.database
      .update(agentSessions)
      .set({ parentExecutionGeneration: null })
      .where(eq(agentSessions.id, setup.childId))
      .run();

    expect(spawnedLink(setup)).toBeUndefined();
    expectNoPendingReports(setup);
    closeSetup(setup);
  });
});
