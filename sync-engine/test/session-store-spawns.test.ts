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

function expectRetainedReport(
  setup: SpawnedChildReference,
  now = TEST_NOW + 5,
): void {
  expect(report(setup, now)).toBe(false);
  expectParentId(setup);
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

function expectNoPendingReports(setup: SpawnedChildReference): void {
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
}

describe("spawned session report generation fencing", () => {
  test("persists and claims the current parent callback", () => {
    const setup = spawnedChildSetup();
    const childDetail = setup.store.get(TEST_USER_ID, setup.childId);

    expect(setup.store.pendingSpawnedSessions()).toEqual([
      { detail: childDetail, userId: TEST_USER_ID },
    ]);
    expect(report(setup)).toBe(true);
    expect(spawnedLink(setup)).toBeUndefined();
    expectNoPendingReports(setup);
    closeAfterParentAssertion(setup, (parent) => {
      expect(parent?.messages.at(-1)?.content).toBe("Child complete");
    });
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

  test("retains the callback for a stopped parent", () => {
    const setup = spawnedChildSetup();
    expect(setup.store.stop(TEST_USER_ID, setup.parentId, TEST_NOW + 5)).toBe(
      true,
    );

    expectRetainedReport(setup, TEST_NOW + 6);
    closeAfterParentAssertion(setup, (parent) => {
      expect(parent?.status).toBe("stopped");
    });
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
