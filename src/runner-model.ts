export type RunnerStatus = "offline" | "online" | "pending";

export interface RunnerSummary {
  readonly architecture: string | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly lastSeenAt: number | null;
  readonly name: string | null;
  readonly platform: string | null;
  readonly status: RunnerStatus;
}

export function createPendingRunnerSummary(id: string): RunnerSummary {
  return {
    architecture: null,
    id,
    isDefault: false,
    lastSeenAt: null,
    name: null,
    platform: null,
    status: "pending",
  };
}
