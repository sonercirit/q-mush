import { expect, test } from "vitest";
import { runnerDirectoriesPath } from "../../shared/routes.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { createSessionRequestHelpers } from "../session-request-helpers.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
} from "./authenticated-integration-test-helpers.ts";

test("returns an HTTP response when directory browsing is canceled", async () => {
  const { auth, database } = createAuthenticatedTestContext();
  const canceledCommands: string[] = [];
  const delivered = Promise.withResolvers<string>();
  const broker = new RunnerCommandBroker({
    cancel: (_runnerId, commandId) => {
      canceledCommands.push(commandId);
    },
    deliver: (_runnerId, command) => {
      delivered.resolve(command.id);
      return true;
    },
  });
  const requests = createSessionRequestHelpers(auth, broker, {
    runnerIsAvailable: () => true,
  });
  const controller = new AbortController();
  const authenticated = createAuthenticatedRequest(
    runnerDirectoriesPath("runner-1"),
    { path: "~" },
    "POST",
  );
  const response = requests.directories(
    new Request(authenticated, { signal: controller.signal }),
    "runner-1",
  );

  const deliveredCommandId = await delivered.promise;
  controller.abort();

  const settled = await response;
  expect(
    broker.complete("runner-1", deliveredCommandId, {
      output: JSON.stringify({ children: [], parent: null, path: "/late" }),
      state: "completed",
    }),
  ).toBe(false);
  expect(settled.status).toBe(502);
  expect(await settled.json()).toEqual({ error: "directory_unavailable" });
  expect(canceledCommands).toEqual([deliveredCommandId]);
  database.$client.close();
});
