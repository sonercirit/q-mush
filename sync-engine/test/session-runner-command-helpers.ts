import { expect } from "vitest";
import type {
  RunnerCommandResult,
  RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import {
  RUNNER_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";

export type CommandSessionSetup = ReturnType<typeof connectedSessionSetup>;

export function completeTestRunnerCommands(
  setup: CommandSessionSetup,
  commands: readonly RunnerToolCommand[],
  result: (command: RunnerToolCommand) => RunnerCommandResult,
): void {
  for (const command of commands) {
    const completed = setup.sessions.completeRunnerCommand(
      RUNNER_ID,
      command.id,
      result(command),
    );
    expect(completed).toBe(true);
  }
}
