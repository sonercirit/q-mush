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
  expectConsumedReportCount(setup, count);
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
}

export function parentState(setup: ReturnType<typeof spawnedChildSetup>) {
  return setup.store.get(TEST_USER_ID, setup.parentId);
}

export function requireParent(setup: ReturnType<typeof spawnedChildSetup>) {
  const parent = parentState(setup);
  if (parent === undefined) throw new Error("Spawned child parent unavailable");
  return parent;
}

export function continuedChildSetup() {
  const setup = spawnedChildSetup();
  const continued = continueChild(setup);
  return { continued, setup };
}

export function reportParentDisposition(
  setup: ReturnType<typeof spawnedChildSetup>,
  delivery: ReturnType<typeof terminalEventActions>,
  disposition: "deferred" | "delivered",
): void {
  delivery.actions.reportedParent(
    { disposition, parentId: setup.parentId },
    TEST_USER_ID,
  );
}

type DeliveryArguments = [
  setup: ReturnType<typeof spawnedChildSetup>,
  delivery: ReturnType<typeof terminalEventActions>,
];

export function reportPendingDelivery(
  ...[setup, delivery]: DeliveryArguments
): void {
  delivery.actions.reportAll(setup.store.pendingSpawnedSessions());
}

export function deferredReportSetup(
  overrides: Parameters<typeof terminalEventActions>[3] = {},
) {
  const setup = spawnedChildSetup();
  const delivery = deliverySetup(setup, overrides);
  delivery.actions.reportOne(requireSpawnedChild(setup), TEST_USER_ID);
  return { delivery, setup };
}

export async function deliverDeferredReport(
  ...[setup, delivery]: DeliveryArguments
): Promise<void> {
  reportParentDisposition(setup, delivery, "deferred");
  await Promise.resolve();
}

export function expectDurableReport(...args: DeliveryArguments): void {
  const [setup, delivery] = args;
  expect(delivery.launchSession).not.toHaveBeenCalled();
  expectConsumedReportCount(setup, 1);
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

function deliverySetup(
  setup: ReturnType<typeof spawnedChildSetup>,
  overrides: Parameters<typeof terminalEventActions>[3] = {},
) {
  return terminalEventActions(setup.store, setup.database, vi.fn(), overrides);
}

export function idleParent(setup: ReturnType<typeof spawnedChildSetup>): void {
  setup.database.$client
    .query("UPDATE agent_sessions SET status = 'idle' WHERE id = ?")
    .run(setup.parentId);
}

export async function expectParentWake(
  ...[setup, delivery]: DeliveryArguments
): Promise<void> {
  await vi.waitFor(() => expectQueuedParent(setup, delivery));
}

export function expectQueuedParentState(
  setup: ReturnType<typeof spawnedChildSetup>,
): void {
  expect(parentState(setup)).toMatchObject({
    generation: setup.parentGeneration + 1,
    status: "queued",
  });
}

function expectQueuedParent(...[setup, delivery]: DeliveryArguments): void {
  expect(delivery.launchSession).toHaveBeenCalledTimes(1);
  expectQueuedParentState(setup);
}

export function expectConsumedReportCount(
  setup: ReturnType<typeof spawnedChildSetup>,
  count: number,
): void {
  expect(reportCount(setup.store, setup.parentId)).toBe(count);
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
