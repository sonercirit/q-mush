import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  executeRunnerCommand,
  readRunnerCommand,
  RunnerCommandExecutor,
} from "../../runner/runner-command.ts";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import { testRunnerCommand } from "../../shared/test/runner-command-fixtures.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_OUTPUT_CHARACTERS,
  toolExecutionLimitSeconds,
} from "../../shared/tool-limits.ts";
import { unicodeCharacterCount } from "../../shared/tool-output-limits.ts";
import { createTestAgentFileWorkspace } from "./agent-file-test-helpers.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-command-test-");

interface SessionExecutor {
  readonly executor: RunnerCommandExecutor;
  readonly root: string;
  readonly sessionId: string;
}

interface SessionToolInvocation {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly outputLimitCharacters?: number;
  readonly session: SessionExecutor;
  readonly tool: string;
}

function sessionCommand(options: SessionToolInvocation): RunnerToolCommand {
  return {
    arguments: options.arguments,
    executionEnvironment: "bare_metal",
    executionLimitSeconds: toolExecutionLimitSeconds(DEFAULT_TOOL_SETTINGS),
    id: `${options.session.sessionId}-${options.tool}`,
    outputLimitCharacters:
      options.outputLimitCharacters ??
      DEFAULT_TOOL_SETTINGS.outputLimitCharacters,
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
  await Bun.write(join(root, path), content);
  return createSessionExecutor(root, sessionId);
}

function readSession(fixture: {
  readonly content: string;
  readonly path: string;
  readonly sessionId: string;
}): Promise<SessionExecutor> {
  return sessionWithFile(fixture.sessionId, fixture.path, fixture.content);
}

function executeSession(
  session: SessionExecutor,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  outputLimitCharacters?: number,
): Promise<string> {
  return session.executor.execute(
    sessionCommand({
      arguments: input,
      ...(outputLimitCharacters === undefined ? {} : { outputLimitCharacters }),
      session,
      tool,
    }),
  );
}

function parsedCommand(overrides: Partial<RunnerToolCommand> = {}) {
  return readRunnerCommand({
    command: testRunnerCommand({
      arguments: { path: "missing.txt" },
      workingDirectory: "/missing-workspace",
      ...overrides,
    }),
  });
}

function expectNoReadContinuation(output: string): void {
  expect(output).not.toContain("Use offset=");
  expect(output).not.toContain("�");
}

function expectRawOverflow(output: string, maximum: number): void {
  expect(unicodeCharacterCount(output)).toBe(maximum + 1);
  expect(output).not.toContain("Tool output truncated");
}

describe("runner WebSocket protocol", () => {
  test("defaults legacy commands and preserves configured settings", () => {
    expect(parsedCommand()).toMatchObject({
      executionLimitSeconds: toolExecutionLimitSeconds(DEFAULT_TOOL_SETTINGS),
      outputLimitCharacters: DEFAULT_TOOL_SETTINGS.outputLimitCharacters,
    });
    expect(
      parsedCommand({
        executionLimitSeconds: 420,
        outputLimitCharacters: 12_345,
      }),
    ).toMatchObject({
      executionLimitSeconds: 420,
      outputLimitCharacters: 12_345,
    });
  });

  test.each([
    { executionLimitSeconds: 0 },
    { executionLimitSeconds: MAXIMUM_TOOL_EXECUTION_MINUTES * 60 + 1 },
    { outputLimitCharacters: 0 },
    { outputLimitCharacters: MAXIMUM_TOOL_OUTPUT_CHARACTERS + 1 },
  ])("rejects invalid command settings %#", (settings) => {
    expect(() => parsedCommand(settings)).toThrow("invalid runner command");
  });

  test("validates commands before executing them", async () => {
    const output = await executeRunnerCommand(parsedCommand());
    expect(output.startsWith("Error:")).toBe(true);
  });

  test("keeps positional read pagination without separate output budgets", async () => {
    const lines = Array.from(
      { length: 2_501 },
      (_value, index) => `${String(index + 1).padStart(4, "0")}-line`,
    );
    const session = await readSession({
      content: lines.join("\n"),
      path: "many-lines.txt",
      sessionId: "session-many-lines",
    });
    const output = await executeSession(
      session,
      "read",
      { limit: 3_000, path: "many-lines.txt" },
      40_000,
    );

    expect(output).toContain(lines[0]);
    expect(output).toContain(lines[2_500]);
    expect(output).not.toContain("Tool output truncated");
  });

  test("retains the continuation marker when the character limit shortens a read page", async () => {
    const maximum = 180;
    const lines = Array.from(
      { length: 200 },
      (_value, index) =>
        `${String(index + 1).padStart(3, "0")}-${"😀".repeat(8)}`,
    );
    const session = await sessionWithFile(
      "session-bounded-continuation",
      "bounded-continuation.txt",
      lines.join("\n"),
    );
    const output = await executeSession(
      session,
      "read",
      { limit: lines.length, path: "bounded-continuation.txt" },
      maximum,
    );

    expect(unicodeCharacterCount(output)).toBeLessThanOrEqual(maximum);
    const continuation =
      /\[Showing lines 1-(\d+) of 200\. Use offset=(\d+) to continue\.\]$/u.exec(
        output,
      );
    expect(continuation).not.toBeNull();
    expect(continuation?.[2]).toBe(
      String(Number.parseInt(continuation?.[1] ?? "0", 10) + 1),
    );
    expect(output).not.toContain(lines.at(-1));
    expect(output).not.toContain("�");
  });

  test("does not advertise a continuation past a partially shown line", async () => {
    const maximum = 120;
    const session = await readSession({
      content: `${"😀".repeat(500)}\ntail`,
      path: "long-line.txt",
      sessionId: "session-long-line",
    });
    const output = await executeSession(
      session,
      "read",
      { limit: 2, path: "long-line.txt" },
      maximum,
    );

    expectRawOverflow(output, maximum);
    expectNoReadContinuation(output);
  });

  test("uses offset and limit only to select a page", async () => {
    const session = await readSession({
      content: ["first", "second", "third", "fourth"].join("\n"),
      path: "content.txt",
      sessionId: "session-page",
    });

    await expect(
      executeSession(session, "read", {
        limit: 2,
        offset: 2,
        path: "content.txt",
      }),
    ).resolves.toBe(
      "second\nthird\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]",
    );
  });

  test("keeps output unchanged at the exact Unicode boundary", async () => {
    const source = "😀".repeat(120);
    const session = await readSession({
      content: source,
      path: "content.txt",
      sessionId: "session-unicode-boundary",
    });

    await expect(
      executeSession(session, "read", { path: "content.txt" }, 120),
    ).resolves.toBe(source);
  });

  test("retains one raw overflow code point for the engine finalizer", async () => {
    const maximum = 200;
    const session = await readSession({
      content: "😀".repeat(500),
      path: "content.txt",
      sessionId: "session-unicode-overflow",
    });
    const output = await executeSession(
      session,
      "read",
      { path: "content.txt" },
      maximum,
    );

    expectRawOverflow(output, maximum);
    expectNoReadContinuation(output);
    expect(output).not.toContain("does not fit");
    expect(output).not.toContain("saved to");
  });

  test("retains failed runner-tool overflow without adding a notice", async () => {
    const maximum = 180;
    const session = createSessionExecutor(
      await temporaryDirectory(),
      "session-failure-bound",
    );
    const output = await executeSession(
      session,
      "read",
      { path: `${"missing".repeat(100)}.txt` },
      maximum,
    );

    expectRawOverflow(output, maximum);
  });

  test("does not truncate internal agent-file or directory payloads", async () => {
    const instructions = "Keep complete instructions. ".repeat(20);
    const root = await createTestAgentFileWorkspace(temporaryDirectory, {
      "AGENTS.md": instructions,
    });
    const session = createSessionExecutor(root, "session-internal-payloads");
    const agentFile = await executeSession(
      session,
      RUNNER_AGENT_FILE_COMMAND,
      {},
      120,
    );
    const directory = await executeSession(
      session,
      "list_directories",
      {},
      120,
    );

    expect(JSON.parse(agentFile)).toEqual({
      content: instructions,
      name: "AGENTS.md",
    });
    expect(JSON.parse(directory)).toMatchObject({ path: root });
  });

  test("preserves normal shell completion and exit reporting", async () => {
    const session = createSessionExecutor(process.cwd(), "session-shell");
    const output = await executeSession(session, "bash", {
      command: "printf completed; exit 7",
      timeout: 5,
    });

    expect(output).toBe("stdout:\ncompleted\nExit code: 7");
  });

  test("distinguishes exact shell output from one-code-point overflow", async () => {
    const contentCharacters = 120;
    const outputLimit = unicodeCharacterCount(
      `stdout:\n${"😀".repeat(contentCharacters)}\nExit code: 0`,
    );
    const session = createSessionExecutor(
      process.cwd(),
      "session-shell-boundary",
    );
    const shell = (characters: number) =>
      executeSession(
        session,
        "bash",
        { command: `printf '${"😀".repeat(characters)}'`, timeout: 5 },
        outputLimit,
      );
    const exact = await shell(contentCharacters);
    const overflow = await shell(contentCharacters + 1);

    expect(exact).toContain("😀".repeat(contentCharacters));
    expect(exact).not.toContain("Tool output truncated");
    expectRawOverflow(overflow, outputLimit);
    expect(overflow).not.toContain("�");
  });

  test("shares one raw capture budget across stdout and stderr", async () => {
    const outputLimit = 160;
    const session = createSessionExecutor(
      process.cwd(),
      "session-shell-shared",
    );
    const result = await session.executor.executeResult(
      sessionCommand({
        arguments: {
          command:
            "printf '%*s' 1048576 '' | tr ' ' o; printf '%*s' 1048576 '' | tr ' ' e >&2",
          timeout: 5,
        },
        outputLimitCharacters: outputLimit,
        session,
        tool: "bash",
      }),
    );

    expectRawOverflow(result.output, outputLimit);
    expect(unicodeCharacterCount(result.output)).toBeLessThan(outputLimit * 2);
  });

  test("streams shell channels and reports explicit terminal states", async () => {
    const streamed: unknown[] = [];
    const session = createSessionExecutor(process.cwd(), "session-stream");
    const completed = await session.executor.executeResult(
      sessionCommand({
        arguments: { command: "printf out; printf err >&2", timeout: 5 },
        session,
        tool: "bash",
      }),
      undefined,
      (delta) => streamed.push(delta),
    );
    const failed = await session.executor.executeResult(
      sessionCommand({
        arguments: { command: "printf failed; exit 7", timeout: 5 },
        session,
        tool: "bash",
      }),
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
