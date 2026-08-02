import { expect, test } from "vitest";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
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

function continueChild(setup: SpawnedChildReference): void {
  expect(
    setup.store.transitionRuntime(
      setup.childId,
      "running",
      TEST_NOW + 7,
      setup.childGeneration + 1,
    ),
  ).toBe(true);
  setup.store.commitRuntimeTerminal(
    setup.childId,
    [
      {
        content: "Continued child result",
        role: "assistant",
        toolCalls: [],
      },
    ],
    TEST_NOW + 8,
    setup.childGeneration + 1,
    null,
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
  expect(setup.store.spawnedSessionLink(TEST_USER_ID, setup.childId)).toBe(
    undefined,
  );
  expect(deliverLateCallback(setup)).toBeUndefined();
  expect(childCallbackCount(setup)).toBe(1);
  expect(queued).toMatchObject({
    detail: {
      generation: setup.childGeneration + 1,
      parentExecutionGeneration: null,
      status: "queued",
    },
  });

  continueChild(setup);

  const continued = setup.store.get(TEST_USER_ID, setup.childId);
  expect(continued).toMatchObject({
    generation: setup.childGeneration + 1,
    parentExecutionGeneration: null,
    status: "idle",
  });
  expect(
    continued?.messages.some(
      ({ content }) => content === "Continued child result",
    ),
  ).toBe(true);
  expect(childCallbackCount(setup)).toBe(1);
  const client = setup.database.$client;
  client.close();
});
