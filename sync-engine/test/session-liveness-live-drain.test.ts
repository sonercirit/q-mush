import { expect, test } from "vitest";
import { createSessionRuntimes } from "../session-runtime.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeSetup,
  launchRuntime,
  runningSetup,
  watchdogSetup,
} from "./session-liveness-watchdog.test.ts";

function markedShutdownSession(
  setup: ReturnType<typeof runningSetup>,
  watchdog: ReturnType<typeof watchdogSetup>,
  restartId: string,
): void {
  const marked = watchdog.shutdownInterrupted.mark(
    setup.detail.id,
    setup.detail.generation,
    restartId,
    "agent",
    TEST_NOW + 2,
  );
  expect(marked).toBe(true);
}

test("a live drain marker is not recovered by production liveness scans", () => {
  const setup = runningSetup();
  const runtimeSet = createSessionRuntimes();
  const watchdog = watchdogSetup(setup, { runtimes: runtimeSet });
  const runtime = launchRuntime(setup, runtimeSet, setup.detail.generation);
  watchdog.shutdownInterrupted.beginLiveDrain();
  markedShutdownSession(setup, watchdog, "live-drain");

  for (let scan = 0; scan < 2; scan += 1) watchdog.scan();

  const duringDrain = setup.store.get(TEST_USER_ID, setup.detail.id);
  expect(duringDrain).toMatchObject({
    generation: setup.detail.generation,
    restartHandoff: null,
    status: "running",
  });
  runtime.resolve(undefined);
  closeSetup(setup);
});
