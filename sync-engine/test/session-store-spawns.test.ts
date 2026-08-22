import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { advanceStoredSessionGeneration } from "../session-generation-advance.ts";
import {
  claimSpawnedSessionReservation,
  failSpawnedSessionReservation,
} from "../session-spawn-reservation-store.ts";
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
): "deferred" | "delivered" | "promoted" | "terminal" | undefined {
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

function updateSession(
  setup: SpawnedChildReference,
  id: string,
  values: Partial<typeof agentSessions.$inferInsert>,
): void {
  setup.database
    .update(agentSessions)
    .set(values)
    .where(eq(agentSessions.id, id))
    .run();
}

function updateGeneration(
  setup: SpawnedChildReference,
  target: "child" | "parent",
): void {
  const id = target === "child" ? setup.childId : setup.parentId;
  const generation =
    target === "child" ? setup.childGeneration : setup.parentGeneration;
  updateSession(setup, id, { executionGeneration: generation + 1 });
}

function advanceChildGeneration(
  setup: SpawnedChildReference,
  mode: "administrative" | "attempt",
  now: number,
) {
  return setup.database.transaction((transaction) =>
    advanceStoredSessionGeneration({
      condition: eq(agentSessions.id, setup.childId),
      database: transaction,
      generateId: () => crypto.randomUUID(),
      mode,
      now,
      sessionId: setup.childId,
      values: { status: "idle" },
    }),
  );
}

function expectReportDisposition(
  setup: SpawnedChildReference,
  claimed: boolean,
  now = TEST_NOW + 5,
): void {
  expect(report(setup, now) !== undefined).toBe(claimed);
  expectParentId(setup);
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

function updateChild(
  setup: SpawnedChildReference,
  values: {
    parentCallbackGeneration?: null;
    parentExecutionGeneration?: null;
    runnerRequired?: true;
  },
): void {
  updateSession(setup, setup.childId, values);
}

function setRunnerRequired(
  setup: SpawnedChildReference,
  id: string,
  runnerRequired: boolean,
): void {
  updateSession(setup, id, { runnerRequired });
}

function expectedPendingReport(
  setup: SpawnedChildReference,
  kind: "follow_up" | "steer" = "steer",
) {
  return {
    clientRequestId: `spawn:${setup.childId}:${String(setup.childGeneration)}`,
    content: "Child complete",
    kind,
  } as const;
}

function expectPendingReport(setup: SpawnedChildReference): void {
  closeAfterParentAssertion(setup, (parent) => {
    expect(parent?.pendingInputs).toMatchObject([expectedPendingReport(setup)]);
  });
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
  test("claims a pending reservation once and only allowClaimed can fail it afterward", () => {
    const setup = createStore();
    const [parent, child] = [
      createTestSession(setup.store),
      createTestSession(setup.store, TEST_NOW + 1),
    ];
    expect(
      setup.store.transitionCurrent(parent.id, "running", TEST_NOW + 2),
    ).toBe(true);
    const reservation = Object.assign(setup, {
      childId: child.id,
      childGeneration: child.generation,
      parentId: parent.id,
      parentGeneration: parent.generation,
    });
    updateSession(reservation, child.id, { spawnPreparationPending: true });
    const identity = {
      generation: child.generation,
      sessionId: child.id,
      userId: TEST_USER_ID,
    };
    const claimOptions = {
      authority: { generation: parent.generation, sessionId: parent.id },
      database: setup.database,
      identity,
    };

    expect(claimSpawnedSessionReservation(claimOptions)).toBe(true);
    expect(claimSpawnedSessionReservation(claimOptions)).toBe(false);
    const failureOptions = {
      content: "Launch failed after claim",
      database: setup.database,
      generateId: () => crypto.randomUUID(),
      identity,
      now: TEST_NOW + 3,
    };
    expect(failSpawnedSessionReservation(failureOptions)).toBe(false);
    expect(
      failSpawnedSessionReservation({ ...failureOptions, allowClaimed: true }),
    ).toBe(true);
    const failed = setup.store.get(TEST_USER_ID, child.id);
    expect(failed?.status).toBe("failed");
    setup.database.$client.close();
  });

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
    if (child.status !== "created") throw new Error("Child creation failed");
    expect(child.detail.tools).toEqual(["read"]);
    expect(
      setup.database.query.agentSessions
        .findFirst({
          columns: { spawnPreparationPending: true },
          where: eq(agentSessions.id, child.detail.id),
        })
        .sync(),
    ).toEqual({ spawnPreparationPending: false });
    expect(setup.store.recoverSpawnedSessionReservations(TEST_NOW + 2)).toBe(0);
    expect(setup.store.get(TEST_USER_ID, child.detail.id)).toMatchObject({
      status: "queued",
    });
    setup.database.$client.close();
  });

  test("bounds and advances re-query pages after reportability filtering", () => {
    const setup = spawnedChildSetup();
    const fixtureRows = setup.database
      .select(getTableColumns(agentSessions))
      .from(agentSessions)
      .all();
    const child = fixtureRows.find(({ id }) => id === setup.childId);
    const parent = fixtureRows.find(({ id }) => id === setup.parentId);
    if (child === undefined || parent === undefined) {
      throw new Error("The spawned-session fixture rows were unavailable");
    }
    const blockedParentId = "runner-required-parent";
    setup.database
      .insert(agentSessions)
      .values({ ...parent, id: blockedParentId, runnerRequired: true })
      .run();
    setup.database
      .insert(agentSessions)
      .values(
        Array.from({ length: 6 }, (_, index) => ({
          ...child,
          createdAt: new Date(child.createdAt.getTime() - 20 + index),
          id: `runner-required-child-${String(index)}`,
          parentSessionId: blockedParentId,
        })),
      )
      .run();
    setup.database
      .insert(agentSessions)
      .values(
        (
          [
            ["idle-child-without-final-response", -1, "idle"],
            ["second-reportable-child", 1, child.status],
            ["third-reportable-child", 2, child.status],
          ] as const
        ).map(([id, timeOffset, status]) => ({
          ...child,
          createdAt: new Date(child.createdAt.getTime() + timeOffset),
          id,
          status,
        })),
      )
      .run();

    expect(
      setup.store.pendingSpawnedSessions(2).map(({ detail }) => detail.id),
    ).toEqual([setup.childId, "second-reportable-child"]);
    closeSetup(setup);
  });

  test("administrative and attempt advances fence opposite report generations", () => {
    for (const mode of ["administrative", "attempt"] as const) {
      const setup = spawnedChildSetup();
      expectReportClaimed(setup);
      const before = setup.childGeneration;

      expect(advanceChildGeneration(setup, mode, TEST_NOW + 6)).toBeDefined();
      const row = setup.database
        .select({ reported: agentSessions.parentReportedGeneration })
        .from(agentSessions)
        .where(eq(agentSessions.id, setup.childId))
        .get();
      expect(row?.reported).toBe(
        mode === "administrative" ? before + 1 : before,
      );
      closeSetup(setup);
    }
  });

  test("refuses an administrative advance until a blocked terminal report is delivered", () => {
    const setup = spawnedChildSetup();
    setRunnerRequired(setup, setup.parentId, true);

    const advanced = advanceChildGeneration(
      setup,
      "administrative",
      TEST_NOW + 5,
    );
    expect(advanced).toBeUndefined();
    expect(childSummary(setup)).toMatchObject({
      generation: setup.childGeneration,
      status: "completed",
    });

    setRunnerRequired(setup, setup.parentId, false);
    expect(setup.store.pendingSpawnedSessions()).toHaveLength(1);
    expectReportClaimed(setup, TEST_NOW + 6);
    expect(setup.store.pendingSpawnedSessions()).toHaveLength(0);
    expectPendingReport(setup);
  });

  test("includes a completed child whose runner was removed when its parent is runnable", () => {
    const setup = spawnedChildSetup();
    updateChild(setup, { runnerRequired: true });

    expect(
      setup.store.pendingSpawnedSessions().map(({ detail }) => detail.id),
    ).toContain(setup.childId);
    expectReportClaimed(setup);
    expectPendingReport(setup);
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
    expect(childSummary(setup)?.parentExecutionGeneration).toBe(
      setup.parentGeneration,
    );
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
    "persists the callback for a terminal %s parent",
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
      ).toBe(false);
      closeAfterParentAssertion(setup, (parent) => {
        expect(parentHasChildReport(parent)).toBe(false);
        expect(parent?.pendingInputs).toMatchObject([
          expectedPendingReport(setup, "follow_up"),
        ]);
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
    expect(parentHasChildReport(paused)).toBe(false);
    expect(paused).toMatchObject({
      pendingInputs: [expectedPendingReport(setup, "follow_up")],
      status: "paused",
    });
    closeSetup(setup);
  });

  test("keeps completed hierarchy links without scheduling another callback", () => {
    const setup = spawnedChildSetup();

    expectReportClaimed(setup);
    expect(
      setup.store.spawnedSessionChildren(TEST_USER_ID, setup.parentId),
    ).toEqual([setup.childId]);
    expect(childSummary(setup)).toMatchObject({
      parentExecutionGeneration: setup.parentGeneration,
      parentSessionId: setup.parentId,
    });
    closeSetup(setup);
  });

  test("does not expose historical links without a generation", () => {
    const setup = spawnedChildSetup();
    updateChild(setup, {
      parentCallbackGeneration: null,
      parentExecutionGeneration: null,
    });

    expect(spawnedLink(setup)).toBeUndefined();
    expectNoPendingReports(setup);
    closeSetup(setup);
  });
});

test("a failed report append does not claim or report delivery", () => {
  const setup = spawnedChildSetup();
  setup.database.$client.run(`
    CREATE TRIGGER remove_parent_before_report
    AFTER UPDATE OF parent_reported_generation ON agent_sessions
    WHEN NEW.id = '${setup.childId}'
    BEGIN
      UPDATE agent_sessions SET is_deleted = 1 WHERE id = '${setup.parentId}';
    END;
  `);

  expect(report(setup)).toBeUndefined();
  expect(
    setup.database
      .select({
        generation: sql<number>`${agentSessions.parentReportedGeneration} + 0`,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, setup.childId),
          eq(agentSessions.userId, TEST_USER_ID),
        ),
      )
      .get()?.generation,
  ).toBe(0);
  closeSetup(setup);
});
