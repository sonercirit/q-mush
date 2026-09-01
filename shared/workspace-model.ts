export const GLOBAL_WORKSPACE_ID = "global";
export const GLOBAL_WORKSPACE_NAME = "Global";
export const DEFAULT_WORKSPACE_NAME = "Default";
const WORKSPACE_NAME_MAXIMUM_LENGTH = 100;
const WORKSPACE_ID_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID_PATTERN.test(value);
}

export function normalizeWorkspaceName(name: string): string | undefined {
  const normalized = name.trim();
  return normalized.length > 0 &&
    normalized.length <= WORKSPACE_NAME_MAXIMUM_LENGTH &&
    normalized.toLocaleLowerCase() !== GLOBAL_WORKSPACE_ID
    ? normalized
    : undefined;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly isDefault: boolean;
  readonly name: string;
}

export interface WorkspaceList {
  readonly defaultWorkspaceId: string;
  readonly workspaces: readonly WorkspaceSummary[];
}
