import { describe, expect, test } from "vitest";
import {
  RunnerCommandBroker,
  type DispatchRunnerToolCommand,
  type RunnerCommandResult,
} from "../../shared/runner-command-broker.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { boundSessionToolOutput } from "../session-tool-output.ts";

const OVERSIZED_OUTPUT = Array.from(
  { length: 3_000 },
  (_value, index) => `session-output-${String(index + 1).padStart(4, "0")}`,
).join("\n");

class SpillBroker extends RunnerCommandBroker {
  readonly commands: DispatchRunnerToolCommand[] = [];
  result: Promise<RunnerCommandResult>;

  constructor(
    result: Promise<RunnerCommandResult> = Promise.resolve({
      output: "/tmp/session-output.txt",
      state: "completed",
    }),
  ) {
    super();
    this.result = result;
  }

  override dispatch(input: DispatchRunnerToolCommand) {
    this.commands.push(input);
    return this.result;
  }
}

function oversizedResult() {
  return { output: OVERSIZED_OUTPUT, state: "completed" as const };
}

function expectBoundedOutput(output: string): void {
  expect(output).toContain("session-output-2000");
  expect(output).not.toContain("session-output-2001");
}

function context(broker: RunnerCommandBroker) {
  return {
    broker,
    detail: { ...TEST_SESSION_DETAIL, generation: 3 },
    isCurrent: () => true,
    signal: new AbortController().signal,
  };
}

async function boundedOutput(broker: RunnerCommandBroker): Promise<string> {
  return (await boundSessionToolOutput(context(broker), oversizedResult()))
    .output;
}

describe("session tool output limits", () => {
  test("passes through under-limit session-tool output untouched", async () => {
    const broker = new SpillBroker();
    const original = { output: "small output", state: "completed" } as const;

    await expect(
      boundSessionToolOutput(context(broker), original),
    ).resolves.toBe(original);
    expect(broker.commands).toEqual([]);
  });

  test("bounds oversized output and dispatches its full content to the runner", async () => {
    const broker = new SpillBroker();
    const output = await boundedOutput(broker);

    expectBoundedOutput(output);
    expect(output).toContain("saved to /tmp/session-output.txt");
    expect(broker.commands).toEqual([
      expect.objectContaining({
        arguments: { content: OVERSIZED_OUTPUT },
        executionEnvironment: TEST_SESSION_DETAIL.executionEnvironment,
        generation: 3,
        queueIfUnavailable: false,
        runnerId: TEST_SESSION_DETAIL.runnerId,
        sessionId: TEST_SESSION_DETAIL.id,
        tool: "spill_tool_output",
        workingDirectory: TEST_SESSION_DETAIL.workingDirectory,
      }),
    ]);
  });

  test("hard-truncates with an explicit note when the runner is unreachable", async () => {
    const output = await boundedOutput(
      new RunnerCommandBroker({ deliver: () => false }),
    );
    expectBoundedOutput(output);
    expect(output).not.toContain("saved to");
    expect(output).toMatch(/session runner is unreachable/u);
  });
});
