import { expect, vi } from "vitest";
import { SessionAgentActions } from "../session-agent-actions.ts";
import { SessionStore } from "../session-store.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import {
  spawnedParentReports,
  terminalEventActionSetup,
} from "./session-race-test-helpers.ts";
import { spawnedChildSetup } from "./session-store-spawn-test-helpers.ts";

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
  await vi.waitFor(() => {
    expect(delivery.launchSession).toHaveBeenCalledTimes(1);
    expect(setup.store.get(TEST_USER_ID, setup.parentId)).toMatchObject({
      generation: setup.parentGeneration + 1,
      status: "queued",
    });
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
