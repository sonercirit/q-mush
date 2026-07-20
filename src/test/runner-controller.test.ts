import { test } from "bun:test";
import { RunnerController } from "../runner-controller.ts";
import { expectRefreshToRemainSilent } from "./controller-test-helpers.ts";

test("an online heartbeat refresh does not notify the unchanged view", async () => {
  let requests = 0;

  await expectRefreshToRemainSilent(
    (onChange) => new RunnerController(onChange),
    () => {
      requests += 1;
      return Promise.resolve(
        Response.json({
          runners: [
            {
              architecture: "x64",
              id: "runner-1",
              lastSeenAt: requests,
              name: "workstation",
              platform: "linux",
              status: "online",
            },
          ],
        }),
      );
    },
  );
});
