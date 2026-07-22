import { expect, test } from "vitest";
import { RunnerController } from "../../solid/runner-controller.ts";
import { expectRealtimeToRemainSilent } from "./controller-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";

test("an online heartbeat update does not notify the unchanged view", async () => {
  let requests = 0;
  const online = [runnerSummary(1)];

  await expectRealtimeToRemainSilent(
    () => new RunnerController(),
    () => {
      requests += 1;
      return Promise.resolve(Response.json({ runners: online }));
    },
    [runnerSummary(2)],
  );
  expect(requests).toBe(1);
});
