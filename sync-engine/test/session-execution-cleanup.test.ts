import { describe, expect, test } from "vitest";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  createRunnerCommandBroker,
  type RunnerCommandResult,
} from "../../shared/runner-command-broker.ts";
import type { DispatchRunnerToolCommand } from "../../shared/runner-command.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { SessionExecutionCleanup } from "../../sync-engine/session-execution-cleanup.ts";

function createRecordingCleanupBroker() {
  const commands: DispatchRunnerToolCommand[] = [];
  return {
    ...createRunnerCommandBroker(),
    commands,
    dispatch(input: DispatchRunnerToolCommand): Promise<RunnerCommandResult> {
      commands.push(input);
      return Promise.resolve({ output: "cleaned", state: "completed" });
    },
  };
}

function cleanupDetail(executionEnvironment: "bare_metal" | "container") {
  return { ...TEST_SESSION_DETAIL, executionEnvironment };
}

function cleanupSetup(executionEnvironment: "bare_metal" | "container") {
  const broker = createRecordingCleanupBroker();
  return {
    broker,
    cleanup: new SessionExecutionCleanup(broker),
    detail: cleanupDetail(executionEnvironment),
  };
}

describe("session execution cleanup", () => {
  test.each(["bare_metal", "container"] as const)(
    "dispatches terminal cleanup for %s sessions",
    async (executionEnvironment) => {
      const setup = cleanupSetup(executionEnvironment);

      await setup.cleanup.cleanupTerminal(setup.detail);

      expect(setup.broker.commands).toHaveLength(1);
      const [command] = setup.broker.commands;
      expect(command?.arguments).toEqual({
        [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true,
      });
      expect(command?.executionEnvironment).toBe(executionEnvironment);
      expect(command?.runnerId).toBe(setup.detail.runnerId);
      expect(command?.sessionId).toBe(setup.detail.id);
      expect(command?.tool).toBe(RUNNER_EXECUTION_CLEANUP_COMMAND);
      expect(command?.workingDirectory).toBe(setup.detail.workingDirectory);
    },
  );
  test("upgrades pending environment cleanup to terminal cleanup", async () => {
    const setup = cleanupSetup("container");

    const environmentCleanup = setup.cleanup.cleanup(setup.detail);
    await setup.cleanup.cleanupTerminal(setup.detail);
    await environmentCleanup;

    expect(setup.broker.commands.map(({ arguments: input }) => input)).toEqual([
      {},
      { [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true },
    ]);
  });
});
