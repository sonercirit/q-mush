import { expect, test } from "bun:test";
import { RunnerController } from "../runner-controller.ts";
import { expectRealtimeToRemainSilent } from "./controller-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";

test("an online heartbeat update does not notify the unchanged view", async () => {
  let requests = 0;
  const online = [runnerSummary(1)];

  await expectRealtimeToRemainSilent(
    (onChange) => new RunnerController(onChange),
    () => {
      requests += 1;
      return Promise.resolve(Response.json({ runners: online }));
    },
    [runnerSummary(2)],
  );
  expect(requests).toBe(1);
});
