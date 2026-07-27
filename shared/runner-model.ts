export const RUNNER_ONLINE_WINDOW_MILLISECONDS = 45_000;

export type RunnerStatus = "offline" | "online" | "pending";

import type { ScopedConnectionSummary } from "./connection-model.ts";

export interface RunnerSummary extends ScopedConnectionSummary {
  readonly architecture: string | null;
  readonly lastSeenAt: number | null;
  readonly name: string | null;
  readonly platform: string | null;
  readonly status: RunnerStatus;
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
