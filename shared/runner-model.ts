export type RunnerStatus = "offline" | "online" | "pending";

export interface RunnerSummary {
  readonly architecture: string | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly isGlobal?: boolean;
  readonly lastSeenAt: number | null;
  readonly name: string | null;
  readonly platform: string | null;
  readonly status: RunnerStatus;
  readonly workspaceIds?: readonly string[];
}

export function createPendingRunnerSummary(
  id: string,
  scopes?: Pick<RunnerSummary, "isGlobal" | "workspaceIds">,
): RunnerSummary {
  return {
    architecture: null,
    id,
    isDefault: false,
    ...scopes,
    lastSeenAt: null,
    name: null,
    platform: null,
    status: "pending",
  };
}
