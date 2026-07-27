import type { RunnerToolCommand } from "../runner-command-broker.ts";

export function testRunnerCommand(
  overrides: Partial<RunnerToolCommand> = {},
): RunnerToolCommand {
  return {
    arguments: { path: "README.md" },
    executionEnvironment: "bare_metal",
    id: "command-1",
    sessionId: "session-1",
    tool: "read",
    workingDirectory: "/work/project",
    ...overrides,
  };
}
