import { expect, test } from "vitest";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeSpawnedChildSetup,
  completeSpawnedChildGeneration,
  deliverSpawnedChildCallback,
  expectPendingSpawnedSessionCount,
  parentLink,
  spawnedChildSetup,
  type SpawnedChildReference,
} from "./session-store-spawn-test-helpers.ts";

function childCallbackCount(setup: SpawnedChildReference): number {
  return (
    setup.store
      .get(TEST_USER_ID, setup.parentId)
      ?.pendingInputs.reduce(
        (count, { content }) =>
          count + Number(content.includes("Spawned session completed")),
        0,
      ) ?? 0
  );
}

function requireChildCallback(setup: SpawnedChildReference) {
  const callback = setup.store
    .get(TEST_USER_ID, setup.parentId)
    ?.pendingInputs.find(({ content }) =>
      content.includes("Spawned session completed"),
    );
  if (callback === undefined) {
    throw new Error("The spawned child callback is unavailable");
  }
  return callback;
}

function finisherCallbackContent(): string {
  const setup = spawnedChildSetup();
  expect(deliverSpawnedChildCallback(setup)).toMatchObject({
    disposition: "promoted",
    parentId: setup.parentId,
  });
  const content = requireChildCallback(setup).content;
  closeSpawnedChildSetup(setup);
  return content;
}

function continueChild(setup: SpawnedChildReference): void {
  completeSpawnedChildGeneration(
    setup,
    setup.childGeneration + 1,
    "Continued child result",
    TEST_NOW + 7,
  );
}

function deliverLateCallback(setup: SpawnedChildReference) {
  const reference = {
    childGeneration: setup.childGeneration,
    childId: setup.childId,
    parentGeneration: setup.parentGeneration,
    parentId: setup.parentId,
  };
  return setup.store.spawnedSessionCallbackDisposition(
    TEST_USER_ID,
    reference.childId,
    reference.childGeneration,
    reference.parentId,
    reference.parentGeneration,
    "Late duplicate callback",
    TEST_NOW + 6,
  );
}

test("manual continuation claims a completed child's pending callback", () => {
  const setup = spawnedChildSetup();
  const queued = setup.store.queue(TEST_USER_ID, setup.childId, TEST_NOW + 5);

  expect(queued.status).toBe("queued");
  expect(childCallbackCount(setup)).toBe(1);
  const callback = requireChildCallback(setup);
  expect(callback.content).toContain("Child terminal assistant message");
  expect(callback.content).toContain('"role": "assistant"');
  expect(callback.content).toBe(finisherCallbackContent());
  const preservedLink = setup.store.spawnedSessionLink(
    TEST_USER_ID,
    setup.childId,
  );
  expect(preservedLink).toEqual(parentLink(setup));
  expect(deliverLateCallback(setup)).toBeUndefined();
  expect(childCallbackCount(setup)).toBe(1);
  expect(queued).toMatchObject({
    detail: {
      generation: setup.childGeneration + 1,
      parentExecutionGeneration: setup.parentGeneration,
      status: "queued",
    },
  });

  continueChild(setup);

  const continued = setup.store.get(TEST_USER_ID, setup.childId);
  expect(continued).toMatchObject({
    generation: setup.childGeneration + 1,
    parentExecutionGeneration: setup.parentGeneration,
    status: "completed",
  });
  expect(
    continued?.messages.some(
      ({ content }) => content === "Continued child result",
    ),
  ).toBe(true);
  expect(childCallbackCount(setup)).toBe(1);
  expectPendingSpawnedSessionCount(setup, 1);
  closeSpawnedChildSetup(setup);
});
