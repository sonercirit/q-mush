import type { RunnerSummary } from "../runner-model.ts";

export function runnerSummary(lastSeenAt: number): RunnerSummary {
  return {
    architecture: "x64",
    id: "runner-1",
    lastSeenAt,
    name: "workstation",
    platform: "linux",
    status: "online",
  };
}
