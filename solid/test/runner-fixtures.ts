import type { RunnerSummary } from "../../shared/runner-model.ts";

export function runnerSummary(lastSeenAt: number): RunnerSummary {
  return {
    architecture: "x64",
    id: "runner-1",
    isDefault: false,
    lastSeenAt,
    name: "workstation",
    platform: "linux",
    status: "online",
  };
}
