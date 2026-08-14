import { readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  RunnerCommandExecutor,
  executeRunnerCommand,
  readRunnerCommand,
} from "../../runner/runner-command.ts";
import { RunnerOutputSpills } from "../../runner/runner-output-spills.ts";
import { executeRunnerToolResult } from "../../runner/runner-tools.ts";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  RUNNER_TOOL_OUTPUT_SPILL_COMMAND,
  RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT,
  type RunnerCommandResult,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { testRunnerCommand } from "../../shared/test/runner-command-fixtures.ts";
import { createTestAgentFileWorkspace } from "./agent-file-test-helpers.ts";
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

interface SessionToolInvocation {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly session: SessionExecutor;
  readonly tool: string;
}

function sessionCommand(options: SessionToolInvocation): RunnerToolCommand {
  return {
    arguments: options.arguments,
    executionEnvironment: "bare_metal",
    id: `${options.session.sessionId}-${options.tool}`,
    sessionId: options.session.sessionId,
    tool: options.tool,
    workingDirectory: options.session.root,
  };
}

function createSessionExecutor(
  root: string,
  sessionId: string,
): SessionExecutor {
  return { executor: new RunnerCommandExecutor(), root, sessionId };
}

async function sessionWithFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<SessionExecutor> {
  const root = await temporaryDirectory();
  await writeFile(join(root, path), content, "utf8");
  return createSessionExecutor(root, sessionId);
}

function readLinesFixture(
  sessionId: string,
  path: string,
  lines: readonly string[],
): Promise<SessionExecutor> {
  return sessionWithFile(sessionId, path, lines.join("\n"));
}

function readSession(fixture: {
  readonly content: string;
  readonly path: string;
  readonly sessionId: string;
}): Promise<SessionExecutor> {
  return sessionWithFile(fixture.sessionId, fixture.path, fixture.content);
}

function executorOutput(
  executor: RunnerCommandExecutor,
  command: RunnerToolCommand,
): Promise<string> {
  return executor.execute(command);
}

function executeSession(
  session: SessionExecutor,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<string> {
  return executorOutput(
    session.executor,
    sessionCommand({ arguments: input, session, tool }),
  );
}

function spillTestSession(sessionId: string): Promise<SessionExecutor> {
  return readSession({
    content: "workspace content",
    path: "existing.txt",
    sessionId,
  });
}

function readSpillContinuation(
  session: SessionExecutor,
  path: string,
): Promise<string> {
  return executeSession(session, "read", { limit: 2, path });
}

async function expectSpillRemoved(path: string): Promise<void> {
  expect(await Bun.file(path).exists()).toBe(false);
}

function cleanupSession(session: SessionExecutor): Promise<void> {
  return executeSession(session, RUNNER_EXECUTION_CLEANUP_COMMAND, {
    [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true,
  }).then(() => undefined);
}

function spillPath(output: string): string {
  const path = /saved to (.+)\. Use the read tool/u.exec(output)?.[1];
  if (path === undefined) {
    throw new Error("The tool output did not include a spill path");
  }
  return path;
}

interface SpillRead {
  readonly content: string;
  readonly path: string;
}

async function spilledOutput(
  options: SessionToolInvocation,
): Promise<SpillRead> {
  const invocationOutput = await executeSession(
    options.session,
    options.tool,
    options.arguments,
  );
  const path = spillPath(invocationOutput);
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

  test("bounds each read independently without creating spill files", async () => {
    const source = ["a".repeat(30_000), "b".repeat(30_000)].join("\n");
    const session = await readSession({
      content: source,
      path: "large.txt",
      sessionId: "session-read-calls",
    });
    const read = (offset: number) =>
      executeSession(session, "read", {
        limit: 1,
        offset,
        path: "large.txt",
      });

    const first = await read(1);
    const second = await read(2);

    expect(first).toContain("a".repeat(30_000));
    expect(first).toContain("Use offset=2 to continue");
    expect(second).toBe("b".repeat(30_000));
    expect(first).not.toContain("saved to");
    expect(second).not.toContain("saved to");
  });

  test("limits a read call to 2,000 lines on the same file", async () => {
    const lines = Array.from({ length: 2_001 }, (_value, index) => {
      const lineNumber = String(index + 1).padStart(4, "0");
      return `${lineNumber}-line`;
    });
    const manyLinesPath = "many-lines.txt";
    const session = await readLinesFixture(
      "session-many-lines",
      manyLinesPath,
      lines,
    );

    const output = await executeSession(session, "read", {
      limit: 10_000,
      path: manyLinesPath,
    });

    expect(output).toContain(lines[1_999]);
    expect(output).not.toContain(lines[2_000]);
    expect(output).toContain(
      "[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]",
    );
    expect(output).not.toContain("saved to");
  });

  test("limits read bytes per call and continues by offset on the same file", async () => {
    const lines = Array.from({ length: 600 }, (_value, index) => {
      const prefix = String(index + 1).padStart(4, "0");
      return `${prefix}-${"x".repeat(95)}`;
    });
    const wideLinesPath = "wide-lines.txt";
    const session = await readLinesFixture(
      "session-read-bytes",
      wideLinesPath,
      lines,
    );

    const output = await executeSession(session, "read", {
      path: wideLinesPath,
    });
    const continuation = /Use offset=(\d+) to continue/u.exec(output)?.[1];
    const nextOffset = Number(continuation);

    expect(Buffer.byteLength(output)).toBeLessThan(52 * 1_024);
    expect(nextOffset).toBeGreaterThan(1);
    expect(nextOffset).toBeLessThan(lines.length);
    expect(output).not.toContain("saved to");
    expect(
      await executeSession(session, "read", {
        limit: 1,
        offset: nextOffset,
        path: wideLinesPath,
      }),
    ).toContain(lines[nextOffset - 1]);
  });

  test("does not spill a single oversized read line", async () => {
    const oversizedLine = "oversized-content-".repeat(4_000);
    const session = await readSession({
      content: oversizedLine,
      path: "oversized.txt",
      sessionId: "session-oversized-line",
    });

    const output = await executeSession(session, "read", {
      path: "oversized.txt",
    });

    expect(output).toContain("exceeds the 50KB read limit");
    expect(output).toContain("same file");
    expect(output).not.toContain("saved to");
  });

  test("spills oversized bash output per call and cleans it up terminally", async () => {
    const session = await spillTestSession("session-bash-spill");
    const command =
      "yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -n 2000";

    const commandArguments = { command, timeout: 5 };
    const first = await spilledOutput({
      arguments: commandArguments,
      session,
      tool: "bash",
    });
    const second = await spilledOutput({
      arguments: commandArguments,
      session,
      tool: "bash",
    });

    expect(first.content).toContain("stdout:\nxxxxxxxx");
    expect(first.content).toContain("Exit code: 0");
    expect(second.path).not.toBe(first.path);
    expect(await readSpillContinuation(session, first.path)).toContain(
      "Use offset=3 to continue",
    );
    const initialPaths = [first.path, second.path];
    for (const path of initialPaths) {
      expect(await Bun.file(path).exists()).toBe(true);
    }

    await cleanupSession(session);
    while (initialPaths.length > 0) {
      await expectSpillRemoved(initialPaths.pop() ?? "");
    }
  });

  test("writes server-routed spills that read can continue and cleanup removes", async () => {
    const session = await spillTestSession("session-routed-spill");
    const content = Array.from(
      { length: 2_500 },
      (_value, index) => `routed-${String(index + 1)}`,
    ).join("\n");
    const path = await executeSession(
      session,
      RUNNER_TOOL_OUTPUT_SPILL_COMMAND,
      {
        [RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT]: content,
      },
    );

    expect(await readFile(path, "utf8")).toBe(content);
    expect(await readSpillContinuation(session, path)).toContain(
      "Use offset=3 to continue",
    );
    await cleanupSession(session);
    await expectSpillRemoved(path);
  });

  async function expectCompletedSpillRead(
    execution: Promise<RunnerCommandResult>,
    spills: RunnerOutputSpills,
    expected: string,
  ): Promise<void> {
    const result = await execution;
    expect(result.state).toBe("completed");
    expect(result.output).toContain(expected);
    await spills.cleanup();
  }

  test("fences result execution before dispatch when already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    const root = await temporaryDirectory();
    const shellCalls: string[] = [];

    const result = await executeRunnerToolResult(
      root,
      "bash",
      { command: "printf must-not-run", timeout: 5 },
      controller.signal,
      undefined,
      {
        shell: (_root, command) => {
          shellCalls.push(command);
          return Promise.resolve("completed");
        },
      },
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(shellCalls).toEqual([]);
  });

  test("reads a contained spill under a symlinked temporary directory", async () => {
    const realTemporary = await temporaryDirectory();
    const linkedTemporary = join(await temporaryDirectory(), "tmp-link");
    await symlink(realTemporary, linkedTemporary);
    const originalTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = linkedTemporary;
    try {
      const spills = new RunnerOutputSpills();
      const path = await spills.spill("contained spill body\n");
      const root = await temporaryDirectory();

      await expectCompletedSpillRead(
        executeRunnerToolResult(root, "read", { path }, undefined, undefined, {
          containPaths: true,
          outputSpills: spills,
        }),
        spills,
        "contained spill body",
      );
    } finally {
      if (originalTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = originalTmpdir;
    }
  });

  test("reads a spill larger than the plain-file byte limit", async () => {
    const spills = new RunnerOutputSpills();
    const oversized = "spilled line\n".repeat(200_000);
    expect(oversized.length).toBeGreaterThan(1_024 * 1_024);
    await expectCompletedSpillRead(
      executeRunnerToolResult(
        await temporaryDirectory(),
        "read",
        { offset: 199_999, path: await spills.spill(oversized) },
        undefined,
        undefined,
        { outputSpills: spills },
      ),
      spills,
      "spilled line",
    );
  });

  test("spills an oversized page fetch result", async () => {
    const root = await temporaryDirectory();
    const spills = new RunnerOutputSpills();
    const fullOutput = "rendered-page-".repeat(5_000);

    const result = await executeRunnerToolResult(
      root,
      "page_fetch",
      { url: "https://example.com" },
      undefined,
      undefined,
      {
        outputSpills: spills,
        pageFetch: () => Promise.resolve(fullOutput),
      },
    );
    const path = spillPath(result.output);

    expect(result.state).toBe("completed");
    expect(await readFile(path, "utf8")).toBe(fullOutput);
    await spills.cleanup();
  });

  test("spills an oversized parallel result without losing child output", async () => {
    const session = await readSession({
      content: "parallel workspace",
      path: "parallel.txt",
      sessionId: "session-parallel-spill",
    });
    const child = (value: string) => ({
      parameters: {
        command: `printf '%s' ${JSON.stringify(value.repeat(30_000))}`,
        timeout: 5,
      },
      recipient_name: "bash",
    });

    const spilled = await spilledOutput({
      arguments: { tool_uses: [child("a"), child("b")] },
      session,
      tool: "parallel",
    });

    expect(spilled.content).not.toContain("[parallel output truncated]");
    expect(spilled.content).toContain('"recipient_name": "bash"');
    expect(spilled.content).toContain("a".repeat(30_000));
    expect(spilled.content).toContain("b".repeat(30_000));
    await cleanupSession(session);
  });

  test("loads the preferred workspace agent file for the server", async () => {
    const root = await createTestAgentFileWorkspace(temporaryDirectory, {
      "AGENTS.md": "Preferred instructions",
      "CLAUDE.md": "Ignored instructions",
    });

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

  test("fences result execution before dispatch when aborted", async () => {
    const controller = new AbortController();
    const shellCalls: string[] = [];
    const root = await temporaryDirectory();
    const result = executeRunnerToolResult(
      root,
      "bash",
      { command: "printf must-not-run", timeout: 5 },
      controller.signal,
      undefined,
      {
        shell: (_root, command) => {
          shellCalls.push(command);
          return Promise.resolve("completed");
        },
      },
    );

    controller.abort();
    await expect(result).rejects.toThrow("The runner command was stopped");
    expect(shellCalls).toEqual([]);
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
