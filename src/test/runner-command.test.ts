import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
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
      tool: "read",
      workingDirectory: "/missing-workspace",
    };
    const command = readRunnerCommand({ command: expected });

    expect(command).toEqual(expected);
    expect(await executeRunnerCommand(command)).toStartWith("Error:");
  });

  test("executes directory-browser commands outside an agent workspace", async () => {
    const output = await executeRunnerCommand({
      arguments: {},
      id: "directory-command",
      sessionId: "directory-picker",
      tool: "list_directories",
      workingDirectory: process.cwd(),
    });
    const listing: unknown = await new Response(output).json();

    expect(listing).toMatchObject({
      parent: dirname(process.cwd()),
      path: process.cwd(),
      truncated: false,
    });
  });

  test("stops a running shell command when the session is canceled", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = executeRunnerCommand(
      {
        arguments: { command: "sleep 10" },
        id: "command-2",
        sessionId: "session-1",
        tool: "bash",
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
