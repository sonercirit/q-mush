import { expect } from "vitest";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
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
    [
      {
        content: "Child terminal assistant message",
        role: "assistant",
        toolCalls: [],
      },
    ],
    TEST_NOW + 4,
    child.generation,
    null,
  );
  return child;
}

export type SpawnedChildReference = ReturnType<typeof spawnedChildSetup>;

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

export function expectParentId(setup: SpawnedChildReference): void {
  expect(setup.store.spawnedSessionLink(TEST_USER_ID, setup.childId)).toEqual({
    parentGeneration: setup.parentGeneration,
    parentId: setup.parentId,
  });
}
