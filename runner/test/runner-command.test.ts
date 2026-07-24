import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  executeRunnerCommandResult,
  readRunnerCommand,
} from "../../runner/runner-command.ts";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-command-test-");

async function executeRunnerCommand(
  ...parameters: Parameters<typeof executeRunnerCommandResult>
): Promise<string> {
  return (await executeRunnerCommandResult(...parameters)).output;
}

function shellCommand(
  root: string,
  command: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  return executeRunnerCommand(
    {
      arguments: { command, timeout },
      id: "shell-command",
      sessionId: "session-1",
      tool: "bash",
      workingDirectory: root,
    },
    signal,
  );
}

async function expectQuickResult(
  result: Promise<string>,
  maximumMilliseconds: number,
): Promise<string> {
  return Promise.race([
    result,
    Bun.sleep(maximumMilliseconds).then(() => {
      throw new Error("The shell command did not settle after termination");
    }),
  ]);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(path).exists()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error("The descendant shell did not start");
}

async function abortAfterFileExists(
  result: Promise<string>,
  controller: AbortController,
  path: string,
): Promise<string> {
  try {
    await waitForFile(path);
  } catch (error) {
    controller.abort();
    await expectQuickResult(result, QUICK_TERMINATION_MILLISECONDS);
    throw error;
  }

  controller.abort();
  return expectQuickResult(result, QUICK_TERMINATION_MILLISECONDS);
}

const DESCENDANT_MARKER = ".runner-descendant-ready";
const DESCENDANT_COMMAND =
  `/bin/sh -c "/bin/sh -c 'printf descendant-ready; ` +
  `printf ready > ${DESCENDANT_MARKER}; sleep 10; :' & wait" & wait`;
const QUICK_TERMINATION_MILLISECONDS = 750;
const TIMEOUT_SECONDS = 1;

describe("runner WebSocket protocol", () => {
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
    const output = await executeRunnerCommand(command);

    expect(output.startsWith("Error:")).toBe(true);
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

  test("stops a shell descendant and grandchild retaining pipes", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    const result = shellCommand(
      root,
      DESCENDANT_COMMAND,
      60,
      controller.signal,
    );

    expect(
      await abortAfterFileExists(
        result,
        controller,
        join(root, DESCENDANT_MARKER),
      ),
    ).toContain("stopped");
  });

  test("times out a shell descendant and grandchild retaining pipes", async () => {
    const root = await temporaryDirectory();
    const result = await expectQuickResult(
      shellCommand(root, DESCENDANT_COMMAND, TIMEOUT_SECONDS),
      TIMEOUT_SECONDS * 1_000 + QUICK_TERMINATION_MILLISECONDS,
    );

    expect(await Bun.file(join(root, DESCENDANT_MARKER)).exists()).toBe(true);
    expect(result).toContain("stdout:\ndescendant-ready");
    expect(result).toContain(
      `Timed out after ${String(TIMEOUT_SECONDS)} seconds.`,
    );
    expect(result).not.toContain("stopped");
  });

  test("does not start a shell for an already-aborted signal", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "started.txt");
    const controller = new AbortController();
    controller.abort();

    const result = await executeRunnerCommand(
      {
        arguments: {
          command: `printf started > ${JSON.stringify(marker)}`,
          timeout: 60,
        },
        id: "already-stopped-command",
        sessionId: "session-1",
        tool: "bash",
        workingDirectory: root,
      },
      controller.signal,
    );

    expect(result).toContain("stopped");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("preserves normal shell completion and exit reporting", async () => {
    const result = await shellCommand(
      process.cwd(),
      "printf completed; exit 7",
      5,
    );

    expect(result).toBe("stdout:\ncompleted\nExit code: 7");
  });

  test("reports explicit runner terminal states without changing canonical output", async () => {
    const root = await temporaryDirectory();
    const failed = await executeRunnerCommandResult({
      arguments: { command: "exit 7", timeout: 5 },
      id: "failed-shell-command",
      sessionId: "session-1",
      tool: "bash",
      workingDirectory: root,
    });
    const timedOut = await executeRunnerCommandResult({
      arguments: { command: "sleep 2", timeout: 1 },
      id: "timed-out-shell-command",
      sessionId: "session-1",
      tool: "bash",
      workingDirectory: root,
    });
    const invalid = await executeRunnerCommandResult({
      arguments: { path: "missing.txt" },
      id: "failed-read-command",
      sessionId: "session-1",
      tool: "read",
      workingDirectory: root,
    });

    expect(failed).toEqual({ output: "Exit code: 7", state: "failed" });
    expect(timedOut).toEqual({
      output: "Timed out after 1 seconds.",
      state: "timed-out",
    });
    expect(invalid).toMatchObject({ state: "failed" });
    expect(invalid.output).toContain("Error:");
  });

  test("streams split UTF-8 output without corrupting code points", async () => {
    const streamed: string[] = [];
    const output = await executeRunnerCommand(
      {
        arguments: {
          command: "printf '\\303'; sleep 0.05; printf '\\251'",
          timeout: 5,
        },
        id: "utf8-shell-command",
        sessionId: "session-1",
        tool: "bash",
        workingDirectory: await temporaryDirectory(),
      },
      undefined,
      (delta) => {
        if (delta.channel === "stdout") {
          streamed.push(delta.content);
        }
      },
    );

    expect(streamed.join("")).toBe("é");
    expect(output).toContain("stdout:\né");
  });

  test("does not split UTF-8 when output reaches its byte limit", async () => {
    const streamed: string[] = [];
    const root = await temporaryDirectory();
    const output = await executeRunnerCommand(
      {
        arguments: {
          command: "head -c 131071 /dev/zero; printf '\\303\\251x'",
          timeout: 5,
        },
        id: "bounded-utf8-shell-command",
        sessionId: "session-1",
        tool: "bash",
        workingDirectory: root,
      },
      undefined,
      (delta) => streamed.push(delta.content),
    );

    expect(streamed.join("")).not.toContain("�");
    expect(output).not.toContain("�");
    expect(output).toContain("[output truncated]");
  });

  test("rejects malformed server commands", () => {
    expect(() =>
      readRunnerCommand({ command: { id: "command-without-fields" } }),
    ).toThrow("invalid runner command");
  });
});
