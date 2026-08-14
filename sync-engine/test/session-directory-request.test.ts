import { expect, test } from "vitest";
import { runnerDirectoriesPath } from "../../shared/routes.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { SessionRequestHelpers } from "../session-request-helpers.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
} from "./authenticated-integration-test-helpers.ts";

test("returns an HTTP response when directory browsing is canceled", async () => {
  const { auth, database } = createAuthenticatedTestContext();
  const canceledCommands: string[] = [];
  const delivered = Promise.withResolvers<undefined>();
  const broker = new RunnerCommandBroker({
    cancel: (_runnerId, commandId) => {
      canceledCommands.push(commandId);
    },
    deliver: () => {
      delivered.resolve();
      return true;
    },
  });
  const requests = new SessionRequestHelpers(auth, broker, {
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

  await delivered.promise;
  controller.abort();

  const settled = await response;
  expect(settled.status).toBe(502);
  expect(await settled.json()).toEqual({ error: "directory_unavailable" });
  expect(canceledCommands).toHaveLength(1);
  database.$client.close();
});
