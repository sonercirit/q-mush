import type { Accessor } from "solid-js";
import type { WorkspaceList } from "../shared/workspace-model.ts";

export function optionalWorkspaces(
  workspaces: Accessor<WorkspaceList | undefined> | undefined,
): Readonly<{ readonly workspaces?: Accessor<WorkspaceList | undefined> }> {
  return workspaces === undefined ? {} : { workspaces };
}

export function workspaceIdsAreValid(
  value: unknown,
): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((id) => typeof id === "string"))
  );
}
