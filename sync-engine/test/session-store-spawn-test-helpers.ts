import { expect } from "vitest";
import type { AgentRecordedMessage } from "../../shared/agent-loop.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import type { SessionAgentActionDependencies } from "../../sync-engine/session-agent-action-helpers.ts";
import { reportSpawnedSessionCompletion } from "../../sync-engine/session-child-lifecycle.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { closeSessionStoreTestSetup } from "./session-launch-race-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

function completedChildWithParent(
  store: SessionStore,
  parent: { readonly generation: number; readonly id: string },
) {
  const child = createTestSession(store, TEST_NOW + 2, {
    parentGeneration: parent.generation,
    parentSessionId: parent.id,
  });
  expect(store.transitionCurrent(child.id, "running", TEST_NOW + 3)).toBe(true);
  store.commitRuntimeTerminal(
    child.id,
    [terminalRecordedMessage("Child terminal assistant message")],
    TEST_NOW + 4,
    child.generation,
    null,
  );
  return child;
}

export type SpawnedChildReference = ReturnType<typeof spawnedChildSetup>;

export function terminalRecordedMessage(content: string): AgentRecordedMessage {
  return { content, role: "assistant", toolCalls: [] };
}

export function transitionSpawnedChild(
  setup: SpawnedChildReference,
  generation: number,
  now: number,
): void {
  expect(
    setup.store.transitionRuntime(setup.childId, "running", now, generation),
  ).toBe(true);
}

export function completeSpawnedChildGeneration(
  setup: SpawnedChildReference,
  generation: number,
  content: string,
  now: number,
): void {
  transitionSpawnedChild(setup, generation, now);
  setup.store.commitRuntimeTerminal(
    setup.childId,
    [terminalRecordedMessage(content)],
    now + 1,
    generation,
    null,
  );
}

export function continueSpawnedChild(
  setup: SpawnedChildReference,
  now: number,
): AgentSessionDetail {
  const queued = setup.store.queue(TEST_USER_ID, setup.childId, now);
  if (queued.status !== "queued") {
    throw new Error(`The child could not be continued: ${queued.status}`);
  }
  return queued.detail;
}

export function spawnedSessionsExcluding(
  store: SessionStore,
  excludedIds: readonly string[],
): readonly AgentSessionSummary[] {
  const excluded = new Set(excludedIds);
  return store.list(TEST_USER_ID).filter(({ id }) => !excluded.has(id));
}

export function requireSpawnedChild(
  setup: SpawnedChildReference,
): AgentSessionDetail {
  const detail = setup.store.get(TEST_USER_ID, setup.childId);
  if (detail === undefined) {
    throw new Error("The spawned child is unavailable");
  }
  return detail;
}

function callbackDependencies(
  setup: SpawnedChildReference,
): SessionAgentActionDependencies {
  return {
    database: setup.database,
    discoverModels: () => unexpectedOperation("model discovery"),
    discoverSessionMetadata: () => unexpectedOperation("metadata discovery"),
    launchSession: () => false,
    notify: () => {
      throw new Error("Unexpected notification");
    },
    now: () => TEST_NOW + 5,
    pendingRestart: () => undefined,
    readCredential: () => Promise.resolve(undefined),
    restartSignal: () => new AbortController().signal,
    runnerIsAvailable: () => true,
    store: setup.store,
    withCredential: () => unexpectedOperation("credential access"),
  };
}

function unexpectedOperation(operation: string): Promise<never> {
  return Promise.reject(new Error(`Unexpected ${operation}`));
}

export function deliverSpawnedChildCallback(
  setup: SpawnedChildReference,
): ReturnType<typeof reportSpawnedSessionCompletion> {
  return reportSpawnedSessionCompletion(
    callbackDependencies(setup),
    requireSpawnedChild(setup),
    TEST_USER_ID,
  );
}

export function spawnedChildSetup() {
  const setup = createStore();
  const parent = createTestSession(setup.store);
  expect(
    setup.store.transitionCurrent(parent.id, "running", TEST_NOW + 1),
  ).toBe(true);
  const child = completedChildWithParent(setup.store, parent);
  return {
    ...setup,
    childGeneration: child.generation,
    childId: child.id,
    parentGeneration: parent.generation,
    parentId: parent.id,
  };
}

export function closeSpawnedChildSetup(
  setup: Pick<SpawnedChildReference, "database">,
): void {
  closeSessionStoreTestSetup(setup);
}

export function expectPendingSpawnedSessionCount(
  setup: SpawnedChildReference,
  count: number,
): void {
  expect(setup.store.pendingSpawnedSessions()).toHaveLength(count);
}

export function expectNoPendingSpawnedSessions(
  setup: SpawnedChildReference,
): void {
  expectPendingSpawnedSessionCount(setup, 0);
}

export function parentLink(setup: SpawnedChildReference) {
  return {
    parentGeneration: setup.parentGeneration,
    parentId: setup.parentId,
  };
}

export function expectParentId(setup: SpawnedChildReference): void {
  const actual = setup.store.spawnedSessionLink(TEST_USER_ID, setup.childId);
  expect(actual).toEqual(parentLink(setup));
}
