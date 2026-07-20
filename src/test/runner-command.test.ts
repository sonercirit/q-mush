import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUNNER_AGENT_FILE_COMMAND } from "../agent-file.ts";
import {
  executeRunnerCommand,
  readRunnerCommand,
  readRunnerCommandStatus,
} from "../runner-command.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-command-test-");

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

  test("loads the preferred workspace agent file for the server", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "AGENTS.md"), "Preferred instructions");
    await writeFile(join(root, "CLAUDE.md"), "Ignored instructions");

    const output = await executeRunnerCommand({
      arguments: {},
      id: "agent-file-command",
      sessionId: "session-1",
      tool: RUNNER_AGENT_FILE_COMMAND,
      workingDirectory: root,
    });

    expect(JSON.parse(output)).toEqual({
      content: "Preferred instructions",
      name: "AGENTS.md",
    });
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
