import { expect, vi } from "vitest";
import { SessionAgentActions } from "../session-agent-actions.ts";
import { SessionStore } from "../session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  spawnedParentReports,
  terminalEventActionSetup,
} from "./session-race-test-helpers.ts";
import {
  continueSpawnedChild,
  requireSpawnedChild,
  spawnedChildSetup,
} from "./session-store-spawn-test-helpers.ts";

export function idleParentDeliverySetup() {
  const setup = spawnedChildSetup();
  idleParent(setup);
  return {
    delivery: terminalEventActions(setup.store, setup.database),
    setup,
  };
}

export function expectConsumedReports(
  setup: ReturnType<typeof spawnedChildSetup>,
  count: number,
): void {
  expect(reportCount(setup.store, setup.parentId)).toBe(count);
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
}

export function requireParent(setup: ReturnType<typeof spawnedChildSetup>) {
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  if (parent === undefined) throw new Error("Spawned child parent unavailable");
  return parent;
}

export function deferredReportSetup(
  overrides: Parameters<typeof terminalEventActions>[3] = {},
) {
  const setup = spawnedChildSetup();
  const delivery = terminalEventActions(
    setup.store,
    setup.database,
    vi.fn(),
    overrides,
  );
  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);
  return { delivery, setup };
}

export async function deliverDeferredReport(
  setup: ReturnType<typeof spawnedChildSetup>,
  delivery: ReturnType<typeof terminalEventActions>,
): Promise<void> {
  delivery.actions.reportedParent(
    { disposition: "deferred", parentId: setup.parentId },
    TEST_USER_ID,
  );
  await Promise.resolve();
}

export function expectDurableReport(
  setup: ReturnType<typeof spawnedChildSetup>,
  delivery: ReturnType<typeof terminalEventActions>,
): void {
  expect(delivery.launchSession).not.toHaveBeenCalled();
  expect(reportCount(setup.store, setup.parentId)).toBe(1);
}

export function continueChild(setup: ReturnType<typeof spawnedChildSetup>) {
  return continueSpawnedChild(setup, TEST_NOW + 6);
}

export function terminalEventActions(
  store: SessionStore,
  database: ConstructorParameters<typeof SessionStore>[0],
  cleanupSession = vi.fn(),
  overrides: Partial<ConstructorParameters<typeof SessionAgentActions>[0]> = {},
) {
  const launchSession = vi.fn(() => true);
  const notify = vi.fn();
  const dependencies = terminalEventActionSetup(
    { database, store },
    launchSession,
    notify,
  );
  const abortSession = vi.fn();
  const cancelSessionCommands = vi.spyOn(
    dependencies.broker,
    "cancelSessionCommands",
  );
  const actions = new SessionAgentActions({
    ...dependencies,
    abortSession,
    cleanupSession,
    ...overrides,
  });
  return {
    abortSession,
    actions,
    cancelSessionCommands,
    cleanupSession,
    launchSession,
    notify,
  };
}

export function idleParent(setup: ReturnType<typeof spawnedChildSetup>): void {
  setup.database.$client
    .query("UPDATE agent_sessions SET status = 'idle' WHERE id = ?")
    .run(setup.parentId);
}

export async function expectParentWake(
  setup: ReturnType<typeof spawnedChildSetup>,
  delivery: ReturnType<typeof terminalEventActions>,
): Promise<void> {
  await vi.waitFor(() =>
    expect(delivery.launchSession).toHaveBeenCalledTimes(1),
  );
  expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
    generation: setup.parentGeneration + 1,
    status: "queued",
  });
}

export function reportCount(store: SessionStore, parentId: string): number {
  return spawnedParentReports(store, parentId).filter((content) =>
    content.startsWith("Spawned session "),
  ).length;
}

export function setChildStatus(
  setup: ReturnType<typeof spawnedChildSetup>,
  status: "completed" | "failed" | "idle" | "paused" | "stopped",
): void {
  setup.database.$client
    .query("UPDATE agent_sessions SET status = ? WHERE id = ?")
    .run(status, setup.childId);
}
