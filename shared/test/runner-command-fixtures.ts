import type { RunnerToolCommand } from "../runner-command-broker.ts";

export function runnerCleanupCommand(
  executionEnvironment: RunnerToolCommand["executionEnvironment"] = "container",
): Omit<RunnerToolCommand, "id" | "sessionId" | "workingDirectory"> {
  return {
    arguments: {},
    executionEnvironment,
    tool: "cleanup_execution_environment",
  };
}

export function runnerToolCommand(
  overrides: Partial<RunnerToolCommand> = {},
): RunnerToolCommand {
  return {
    arguments: {},
    executionEnvironment: "bare_metal",
    id: "command-1",
    sessionId: "session-1",
    tool: "read",
    workingDirectory: "/work/project",
    ...overrides,
  };
}
