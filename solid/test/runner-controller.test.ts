import { afterEach, expect, test } from "vitest";
import { connectionScopesPath, RUNNERS_PATH } from "../../shared/routes.ts";
import { RunnerController } from "../../solid/runner-controller.ts";
import {
  expectRealtimeToRemainSilent,
  installRecordedFetch,
} from "./controller-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

test("uses the selected workspace for runner load, creation, and scope updates", async () => {
  const requests: Parameters<typeof installRecordedFetch>[0] = [];
  installRecordedFetch(requests, (init) =>
    init?.method === "POST"
      ? Response.json(
          {
            runner: {
              ...runnerSummary(0),
              isGlobal: false,
              status: "pending",
              workspaceIds: ["workspace/one"],
            },
            setup: { command: "install", downloadUrl: "/download" },
          },
          { status: 201 },
        )
      : init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json({ runners: [] }),
  );
  const controller = new RunnerController();
  controller.setWorkspace("workspace/one");

  await controller.load();
  requests.length = 0;
  await controller.create();
  const creationRequests = [...requests];
  requests.length = 0;
  await controller.setScopes("runner-1", ["workspace-two"]);

  expect(creationRequests).toContainEqual({
    body: undefined,
    method: "POST",
    url: `${RUNNERS_PATH}?workspaceId=workspace%2Fone`,
  });
  expect(requests).toContainEqual({
    body: { workspaceIds: ["workspace-two"] },
    method: "PUT",
    url: connectionScopesPath(RUNNERS_PATH, "runner-1"),
  });
});
