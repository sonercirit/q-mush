import { eq, inArray } from "drizzle-orm";
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

function report(
  setup: SpawnedChildReference,
  now = TEST_NOW + 5,
): "delivered" | "promoted" | "terminal" | undefined {
  return setup.store.spawnedSessionCallbackDisposition(
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
  expect(report(setup, now) !== undefined).toBe(claimed);
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

function parentHasChildReport(
  parent: ReturnType<SpawnedChildReference["store"]["get"]>,
): boolean {
  return (
    parent?.messages.some(({ content }) => content === "Child complete") ===
    true
  );
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

  test("skips over more than a batch of callbacks blocked by runner-required parents", () => {
    const setup = spawnedChildSetup();
    const fixtureRows = setup.database
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.id, [setup.parentId, setup.childId]))
      .all();
    const parent = fixtureRows.find(({ id }) => id === setup.parentId);
    const child = fixtureRows.find(({ id }) => id === setup.childId);
    if (parent === undefined || child === undefined) {
      throw new Error("The spawned-session fixture rows were unavailable");
    }
    setup.database.$client
      .query("UPDATE agent_sessions SET runner_required = 1 WHERE id = ?")
      .run(setup.parentId);
    for (let index = 0; index < 100; index += 1) {
      setup.database
        .insert(agentSessions)
        .values({
          ...child,
          id: `blocked-child-${String(index).padStart(3, "0")}`,
        })
        .run();
    }
    const deliverableParentId = "deliverable-parent";
    const deliverableChildId = "deliverable-child";
    setup.database
      .insert(agentSessions)
      .values({ ...parent, id: deliverableParentId, runnerRequired: false })
      .run();
    setup.database
      .insert(agentSessions)
      .values({
        ...child,
        id: deliverableChildId,
        parentSessionId: deliverableParentId,
      })
      .run();

    expect(
      setup.store.pendingSpawnedSessions(100).map(({ detail }) => detail.id),
    ).toContain(deliverableChildId);
    closeSetup(setup);
  });

  test("persists and claims the current parent callback", () => {
    const setup = spawnedChildSetup();
    const childDetail = setup.store.get(TEST_USER_ID, setup.childId);

    expect(setup.store.pendingSpawnedSessions()).toEqual([
      { detail: childDetail, userId: TEST_USER_ID },
    ]);
    expectReportClaimed(setup);
    const currentParent = setup.store.get(TEST_USER_ID, setup.parentId);
    expect(currentParent?.status).toBe("running");
    expect(currentParent?.pendingInputs).toMatchObject([
      expectedPendingReport(setup),
    ]);
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
    expect(report(setup, TEST_NOW + 6)).toBeUndefined();
    expect(
      setup.store.get(TEST_USER_ID, setup.parentId)?.pendingInputs,
    ).toMatchObject([expectedPendingReport(setup)]);
    closeSetup(setup);
  });

  test("delivers the callback when the parent generation changes", () => {
    const setup = spawnedChildSetup();
    updateGeneration(setup, "parent");

    expectReportClaimed(setup);
    closeAfterParentAssertion(setup, (parent) => {
      expect(parent).toMatchObject({
        pendingInputs: [expectedPendingReport(setup)],
        status: "running",
      });
    });
  });

  test("retains the callback when the child generation changes", () => {
    const setup = spawnedChildSetup();
    updateGeneration(setup, "child");

    expectRetainedReport(setup);
    closeSetup(setup);
  });

  test.each(["failed", "idle", "stopped"] as const)(
    "consumes the callback for a terminal %s parent on the child transcript",
    (status) => {
      const setup = spawnedChildSetup();
      if (status === "failed") {
        expect(
          setup.store.transitionRuntime(
            setup.parentId,
            "failed",
            TEST_NOW + 5,
            setup.parentGeneration,
          ),
        ).toBe(true);
      } else {
        expect(
          setup.store.transitionRuntime(
            setup.parentId,
            "idle",
            TEST_NOW + 5,
            setup.parentGeneration,
          ),
        ).toBe(true);
        if (status === "stopped") {
          expect(
            setup.store.stop(TEST_USER_ID, setup.parentId, TEST_NOW + 6),
          ).toBe(true);
        }
      }

      expectReportClaimed(setup, TEST_NOW + 7);
      expect(
        setup.store
          .get(TEST_USER_ID, setup.childId)
          ?.messages.some(({ role }) => role === "system"),
      ).toBe(true);
      closeAfterParentAssertion(setup, (parent) => {
        expect(parentHasChildReport(parent)).toBe(false);
        expect(parent?.pendingInputs).toEqual([]);
        expect(parent?.status).toBe(status);
      });
    },
  );

  test("stores the callback without falling through for a paused parent", () => {
    const setup = spawnedChildSetup();
    expect(
      setup.store.pauseRunningForRestart(
        {
          generation: setup.parentGeneration,
          sessionId: setup.parentId,
        },
        "server",
        "spawn-report-restart",
        "agent",
        TEST_NOW + 5,
      ),
    ).toBe(true);

    expectReportClaimed(setup, TEST_NOW + 6);
    const paused = setup.store.get(TEST_USER_ID, setup.parentId);
    expect(parentHasChildReport(paused)).toBe(true);
    expect(paused).toMatchObject({ pendingInputs: [], status: "paused" });
    closeSetup(setup);
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
