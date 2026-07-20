import { describe, expect, test } from "bun:test";
import {
  executeRunnerCommand,
  readRunnerCommand,
  readRunnerCommandStatus,
} from "../runner-command.ts";

describe("runner work protocol", () => {
  test("reads command cancellation status", () => {
    expect(readRunnerCommandStatus({ active: true })).toBeTrue();
    expect(() => readRunnerCommandStatus({ active: "yes" })).toThrow(
      "invalid runner command status",
    );
  });

  test("validates commands before executing them", async () => {
    const expected = {
      arguments: { path: "missing.txt" },
      id: "command-1",
      sessionId: "session-1",
      tool: "read_file",
      workingDirectory: "/missing-workspace",
    };
    const command = readRunnerCommand({ command: expected });

    expect(command).toEqual(expected);
    expect(await executeRunnerCommand(command)).toStartWith("Error:");
  });

  test("stops a running shell command when the session is canceled", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = executeRunnerCommand(
      {
        arguments: { command: "sleep 10" },
        id: "command-2",
        sessionId: "session-1",
        tool: "run_command",
        workingDirectory: process.cwd(),
      },
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 20);

    expect(await result).toContain("stopped");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("rejects malformed server commands", () => {
    expect(() =>
      readRunnerCommand({ command: { id: "command-without-fields" } }),
    ).toThrow("invalid runner command");
  });
});
