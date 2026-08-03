import { expect, test, vi } from "vitest";
import { DatabaseWriteResilience } from "../database-write-resilience.ts";
import { EngineHealth } from "../engine-health.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { closeCompactionStore } from "./session-compaction-test-helpers.ts";
import {
  expectFailedLaunch,
  launchFailureSetup,
} from "./session-launch-failure-helpers.ts";
import { CREDENTIAL } from "./session-restart-orchestration-test-helpers.ts";
import { createStore } from "./session-store-test-fixtures.ts";

function completeAgentFile(setup: ReturnType<typeof launchFailureSetup>): void {
  const command = setup.broker.take(setup.detail.runnerId);
  if (command === undefined) {
    throw new Error("The recovered run did not request its agent file");
  }
  expect(
    setup.broker.complete(setup.detail.runnerId, command.id, {
      output: "null",
      state: "completed",
    }),
  ).toBe(true);
}

test("launch failure at the queued transition is visible and continuable", async () => {
  let attempts = 0;
  const diskFull = Object.assign(new Error("database or disk is full"), {
    code: "SQLITE_FULL",
  });
  const setup = launchFailureSetup(
    createStore(),
    new DatabaseWriteResilience({
      attempt: (operation) => {
        attempts += 1;
        if (attempts <= 4) throw diskFull;
        return operation();
      },
      health: new EngineHealth(vi.fn()),
      sleep: () => undefined,
    }),
    TEST_NOW + 3,
  );
  await setup.runtimes.settled(setup.detail.id);
  expectFailedLaunch(setup);
  const continued = setup.storeSetup.store.queue(
    TEST_USER_ID,
    setup.detail.id,
    TEST_NOW + 6,
  );
  expect(continued.status).toBe("queued");
  if (continued.status !== "queued") {
    throw new Error("The failed launch was not continuable");
  }
  expect(
    setup.launcher.launch(continued.detail, CREDENTIAL, TEST_USER_ID),
  ).toBe(true);
  await Promise.resolve();
  completeAgentFile(setup);
  await setup.runtimes.settled(setup.detail.id);
  const recovered = setup.storeSetup.store.get(TEST_USER_ID, setup.detail.id);
  expect(recovered?.activeStartedAt).toBeNull();
  expect(recovered?.status).toBe("idle");
  expect(recovered?.messages.at(-1)).toMatchObject({
    content: "Continued after recovery.",
    role: "assistant",
  });

  setup.finished.mockRestore();
  closeCompactionStore(setup.storeSetup);
});
