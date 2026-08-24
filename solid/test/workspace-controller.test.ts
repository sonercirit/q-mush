import { expect, test } from "vitest";
import { WORKSPACES_PATH, workspaceDefaultPath } from "../../shared/routes.ts";
import { createWorkspaceController } from "../../solid/workspace-controller.ts";
import {
  installRecordedRequestFetch,
  restoreFetchAfterEach,
} from "./controller-test-helpers.ts";

const DEFAULT_WORKSPACE = {
  id: "workspace-default",
  isDefault: true,
  name: "Default",
};

function workspaceList(name = "Projects") {
  return {
    defaultWorkspaceId: DEFAULT_WORKSPACE.id,
    workspaces: [
      DEFAULT_WORKSPACE,
      { id: "workspace-projects", isDefault: false, name },
    ],
  };
}

restoreFetchAfterEach();

test("loads, selects, renames, defaults, and removes workspaces", async () => {
  const selected: string[] = [];
  const requests: {
    readonly body: unknown;
    readonly method: string;
    readonly url: string;
  }[] = [];
  let list = workspaceList();

  installRecordedRequestFetch(requests, (_request, init) => {
    if (init?.method === "PATCH") list = workspaceList("Renamed");
    return (init?.method ?? "GET") === "GET"
      ? Response.json(list)
      : new Response(null, { status: 204 });
  });
  const controller = createWorkspaceController((workspaceId) => {
    selected.push(workspaceId);
  });

  await controller.load();
  expect(selected).toEqual([DEFAULT_WORKSPACE.id]);
  controller.select("workspace-projects");
  await controller.rename("workspace-projects", "Renamed");
  await controller.setDefault("workspace-projects");
  await controller.remove("workspace-projects");

  expect(controller.state.workspaces?.workspaces).toContainEqual({
    id: "workspace-projects",
    isDefault: false,
    name: "Renamed",
  });
  expect(requests).toContainEqual({
    body: { name: "Renamed" },
    method: "PATCH",
    url: `${WORKSPACES_PATH}/workspace-projects`,
  });
  expect(requests).toContainEqual({
    body: undefined,
    method: "POST",
    url: workspaceDefaultPath("workspace-projects"),
  });
  expect(requests).toContainEqual({
    body: undefined,
    method: "DELETE",
    url: `${WORKSPACES_PATH}/workspace-projects`,
  });
});
