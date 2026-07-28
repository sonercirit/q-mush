import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  RunnerCommandExecutor,
  executeRunnerCommand,
  readRunnerCommand,
} from "../../runner/runner-command.ts";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { testRunnerCommand } from "../../shared/test/runner-command-fixtures.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-command-test-");

function shellCommand(
  root: string,
  command: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  return executeRunnerCommand(
    {
      arguments: { command, timeout },
      executionEnvironment: "bare_metal",
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

interface SessionExecutor {
  readonly executor: RunnerCommandExecutor;
  readonly root: string;
  readonly sessionId: string;
}

function sessionCommand(options: {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly session: SessionExecutor;
  readonly tool: string;
}): RunnerToolCommand {
  return {
    arguments: options.arguments,
    executionEnvironment: "bare_metal",
    id: `${options.session.sessionId}-${options.tool}`,
    sessionId: options.session.sessionId,
    tool: options.tool,
    workingDirectory: options.session.root,
  };
}

async function readSession(
  sessionId: string,
  path: string,
  content: string,
): Promise<SessionExecutor> {
  const root = await temporaryDirectory();
  await writeFile(join(root, path), content, "utf8");
  return { executor: new RunnerCommandExecutor(), root, sessionId };
}

function executeSession(
  session: SessionExecutor,
  tool: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  return session.executor.execute(
    sessionCommand({ arguments: arguments_, session, tool }),
  );
}

function cleanupSession(session: SessionExecutor): Promise<void> {
  return executeSession(session, RUNNER_EXECUTION_CLEANUP_COMMAND, {
    [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true,
  }).then(() => undefined);
}

function spillPath(output: string): string {
  const path = /saved to (.+)\. Read that file/u.exec(output)?.[1];
  if (path === undefined) {
    throw new Error("The read output did not include a spill path");
  }
  return path;
}

async function readSpill(
  session: SessionExecutor,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<{ readonly content: string; readonly path: string }> {
  const output = await executeSession(session, "read", arguments_);
  const path = spillPath(output);
  return { content: await readFile(path, "utf8"), path };
}

describe("runner WebSocket protocol", () => {
  test("validates commands before executing them", async () => {
    const expected = testRunnerCommand({
      arguments: { path: "missing.txt" },
      workingDirectory: "/missing-workspace",
    });
    const command = readRunnerCommand({ command: expected });

    expect(command).toEqual(expected);
    const output = await executeRunnerCommand(command);

    expect(output.startsWith("Error:")).toBe(true);
  });

  test("keeps a session read budget and spills across agent runtime loads", async () => {
    const source = ["a".repeat(30_000), "b".repeat(30_000)].join("\n");
    const session = await readSession(
      "session-read-budget",
      "large.txt",
      source,
    );
    const read = (offset: number) =>
      executeSession(session, "read", {
        limit: 1,
        offset,
        path: "large.txt",
      });
    const loadAgentFile = () =>
      executeSession(session, RUNNER_AGENT_FILE_COMMAND, {});

    const first = await read(1);
    expect(first).toContain("a".repeat(30_000));
    expect(first).toContain("Use offset=2 to continue");
    await loadAgentFile();
    const overflow = await read(2);
    const path = spillPath(overflow);

    expect(overflow).toContain("b".repeat(20_000));
    expect(overflow).toContain("global read limit (51200 bytes)");
    await loadAgentFile();
    expect(await executeSession(session, "read", { path })).toBe(
      "b".repeat(30_000),
    );
    const existsBeforeCleanup = await Bun.file(path).exists();
    expect(existsBeforeCleanup).toBe(true);

    await cleanupSession(session);
    const existsAfterCleanup = await Bun.file(path).exists();
    expect(existsAfterCleanup).toBe(false);
  });

  test("spills the continuation instruction for reads over 2,000 lines", async () => {
    const lines = Array.from(
      { length: 2_001 },
      (_, index) => `${String(index + 1).padStart(4, "0")}-${"x".repeat(30)}`,
    );
    const session = await readSession(
      "session-many-lines",
      "many-lines.txt",
      lines.join("\n"),
    );

    const spilled = await readSpill(session, {
      limit: 2_000,
      path: "many-lines.txt",
    });
    await cleanupSession(session);

    expect(spilled.content).toContain(lines[1_999]);
    expect(spilled.content).not.toContain(lines[2_000]);
    expect(spilled.content).toContain(
      "[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]",
    );
  });

  test("reads back a spill larger than the source file limit", async () => {
    const lineCount = 2_000;
    const maximumFileBytes = 1_024 * 1_024;
    const contentBytes = maximumFileBytes - lineCount;
    const lineLength = Math.floor(contentBytes / lineCount);
    const longerLines = contentBytes % lineCount;
    const source = `${Array.from({ length: lineCount }, (_, index) =>
      "x".repeat(lineLength + (index < longerLines ? 1 : 0)),
    ).join("\n")}\n`;
    const session = await readSession(
      "session-maximum-file",
      "maximum.txt",
      source,
    );

    const spilled = await readSpill(session, { path: "maximum.txt" });
    const spillTail = await executeSession(session, "read", {
      offset: lineCount + 1,
      path: spilled.path,
    });
    await cleanupSession(session);

    expect(Buffer.byteLength(source)).toBe(maximumFileBytes);
    expect(Buffer.byteLength(spilled.content)).toBeGreaterThan(
      maximumFileBytes,
    );
    expect(spillTail).toContain("Use offset=2001 to continue.");
  });

  test("preserves and exposes a single oversized line through its spill", async () => {
    const oversizedLine = "oversized-content-".repeat(4_000);
    const session = await readSession(
      "session-oversized-line",
      "oversized.txt",
      oversizedLine,
    );

    const spilled = await readSpill(session, { path: "oversized.txt" });
    const continued = await executeSession(session, "read", {
      limit: 1,
      path: spilled.path,
    });
    await cleanupSession(session);

    expect(spilled.content).toBe(oversizedLine);
    expect(continued).toBe(oversizedLine);
  });

  test("loads the preferred workspace agent file for the server", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "AGENTS.md"), "Preferred instructions");
    await writeFile(join(root, "CLAUDE.md"), "Ignored instructions");

    const output = await executeRunnerCommand({
      arguments: {},
      executionEnvironment: "bare_metal",
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
      executionEnvironment: "bare_metal",
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
        executionEnvironment: "bare_metal",
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

  test("streams shell channels and reports explicit terminal states", async () => {
    const streamed: unknown[] = [];
    const executor = new RunnerCommandExecutor();
    const command = (shell: string, id: string) => ({
      arguments: { command: shell, timeout: 5 },
      executionEnvironment: "bare_metal" as const,
      id,
      sessionId: "session-stream",
      tool: "bash",
      workingDirectory: process.cwd(),
    });

    const completed = await executor.executeResult(
      command("printf out; printf err >&2", "stream-output"),
      undefined,
      (delta) => streamed.push(delta),
    );
    const failed = await executor.executeResult(
      command("printf failed; exit 7", "stream-failed"),
    );

    expect(streamed).toHaveLength(2);
    expect(streamed).toEqual(
      expect.arrayContaining([
        { channel: "stderr", content: "err" },
        { channel: "stdout", content: "out" },
      ]),
    );
    expect(completed).toEqual({
      output: "stdout:\nout\nstderr:\nerr\nExit code: 0",
      state: "completed",
    });
    expect(failed).toEqual({
      output: "stdout:\nfailed\nExit code: 7",
      state: "failed",
    });
  });

  test("rejects malformed server commands", () => {
    expect(() =>
      readRunnerCommand({ command: { id: "command-without-fields" } }),
    ).toThrow("invalid runner command");
  });
});
