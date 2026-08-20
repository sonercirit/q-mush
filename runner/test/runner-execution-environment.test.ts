import { symlink } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  readRunnerCommand,
  RunnerCommandExecutor,
} from "../../runner/runner-command.ts";
import type { RunnerContainerManager } from "../../runner/runner-container.ts";
import {
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type RunnerExecutionEnvironment,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const workspace = useTemporaryDirectories("q-mush-environment-test-");

class FakeContainers {
  readonly cleaned: string[] = [];
  readonly prepared: {
    readonly root: string;
    readonly sessionId: string;
    readonly signal: AbortSignal | undefined;
  }[] = [];
  shellOutput = "container shell output";
  readonly shells: {
    readonly command: string;
    readonly root: string;
    readonly sessionId: string;
    readonly timeout: number;
  }[] = [];

  cleanupSession(sessionId: string): Promise<void> {
    this.cleaned.push(sessionId);
    return Promise.resolve();
  }

  prepare(
    ...input: Parameters<RunnerContainerManager["prepare"]>
  ): Promise<void> {
    const [sessionId, root, signal] = input;
    this.prepared.push({ root, sessionId, signal });
    return Promise.resolve();
  }

  executeShell(
    sessionId: string,
    root: string,
    command: string,
    timeout: number,
  ): Promise<string> {
    this.shells.push({ command, root, sessionId, timeout });
    return Promise.resolve(this.shellOutput);
  }
}

function command(
  tool: string,
  executionEnvironment: RunnerExecutionEnvironment = "container",
  workingDirectory = process.cwd(),
  arguments_?: RunnerToolCommand["arguments"],
): RunnerToolCommand {
  return {
    arguments:
      arguments_ ??
      (tool === "bash"
        ? { command: "pwd", timeout: 5 }
        : { path: "/workspace/README.md" }),
    executionEnvironment,
    id: `command-${tool}`,
    sessionId: "session-1",
    tool,
    workingDirectory,
  };
}

function containerExecutor(): {
  readonly containers: FakeContainers;
  readonly executor: RunnerCommandExecutor;
} {
  const containers = new FakeContainers();
  return { containers, executor: new RunnerCommandExecutor(containers) };
}

describe("container runner commands", () => {
  test("defaults omitted execution environments to bare metal", () => {
    expect(
      readRunnerCommand({
        command: {
          arguments: {},
          id: "legacy-command",
          sessionId: "legacy-session",
          tool: "read",
          workingDirectory: "/work/project",
        },
      }),
    ).toMatchObject({ executionEnvironment: "bare_metal" });
  });

  test("maps absolute container paths and routes bash into one session container", async () => {
    const root = await workspace();
    await Bun.write(`${root}/README.md`, "# Q Mush");
    const { containers, executor } = containerExecutor();
    const controller = new AbortController();

    const parallel = await executor.execute(
      {
        arguments: {
          tool_uses: [
            {
              parameters: { content: "mapped", path: "/workspace/mapped.txt" },
              recipient_name: "write",
            },
            {
              parameters: { command: "pwd", timeout: 5 },
              recipient_name: "bash",
            },
          ],
        },
        executionEnvironment: "container",
        id: "command-parallel",
        sessionId: "session-1",
        tool: "parallel",
        workingDirectory: root,
      },
      controller.signal,
    );
    const read = await executor.execute(command("read", "container", root));

    expect(parallel).toContain("container shell output");
    expect(await Bun.file(`${root}/mapped.txt`).text()).toBe("mapped");
    expect(read).toContain("# Q Mush");
    expect(containers.prepared).toEqual([
      { root, sessionId: "session-1", signal: controller.signal },
      { root, sessionId: "session-1", signal: undefined },
    ]);
    expect(containers.shells).toEqual([
      {
        command: "pwd",
        root,
        sessionId: "session-1",
        timeout: 5,
      },
    ]);
  });

  test("confines container file tools and agent files to the workspace", async () => {
    const outside = await workspace();
    const root = `${outside}/workspace`;
    await Bun.write(`${root}/README.md`, "# Contained");
    await Bun.write(`${outside}/secret.txt`, "host secret");
    await symlink(`${outside}/secret.txt`, `${root}/AGENTS.md`);
    const { executor } = containerExecutor();

    const escape = await executor.execute(
      command("read", "container", root, { path: "../secret.txt" }),
    );
    const absoluteEscape = await executor.execute(
      command("read", "container", root, { path: `${outside}/secret.txt` }),
    );
    const agentFile = await executor.execute({
      arguments: {},
      executionEnvironment: "container",
      id: "command-agent-file",
      sessionId: "session-1",
      tool: "read_agent_file",
      workingDirectory: root,
    });

    const writeEscape = await executor.execute(
      command("write", "container", root, {
        content: "leak",
        path: `${outside}/injected.txt`,
      }),
    );
    const editEscape = await executor.execute(
      command("edit", "container", root, {
        edits: [{ newText: "changed", oldText: "host secret" }],
        path: "../secret.txt",
      }),
    );
    const explainEscape = await executor.execute(
      command("explain_file", "container", root, {
        path: `${outside}/secret.txt`,
      }),
    );
    const parallelEscape = await executor.execute(
      command("parallel", "container", root, {
        tool_uses: [
          {
            parameters: { path: "../secret.txt" },
            recipient_name: "read",
          },
          {
            parameters: { content: "leak", path: `${outside}/parallel.txt` },
            recipient_name: "write",
          },
        ],
      }),
    );

    expect(escape).toContain("outside the session workspace");
    expect(absoluteEscape).toContain("outside the session workspace");
    expect(agentFile).toContain("outside the session workspace");
    for (const blocked of [writeEscape, editEscape, explainEscape]) {
      expect(blocked).toContain("outside the session workspace");
    }
    expect(
      parallelEscape.match(/outside the session workspace/gu),
    ).toHaveLength(2);
    const leaked = await Promise.all(
      ["injected.txt", "parallel.txt"].map((name) =>
        Bun.file(`${outside}/${name}`).exists(),
      ),
    );
    expect(leaked).toEqual([false, false]);
    expect(await Bun.file(`${outside}/secret.txt`).text()).toBe("host secret");
    expect(
      await executor.execute(
        command("read", "container", root, { path: "README.md" }),
      ),
    ).toContain("# Contained");
  });

  test("cleans a tracked container only for an explicit session cleanup command", async () => {
    const containers = new FakeContainers();
    const executor = new RunnerCommandExecutor(containers);

    expect(
      await executor.execute({
        arguments: {},
        executionEnvironment: "container",
        id: "cleanup-command",
        sessionId: "session-1",
        tool: "cleanup_execution_environment",
        workingDirectory: process.cwd(),
      }),
    ).toBe("Container execution environment removed.");

    expect(containers.cleaned).toEqual(["session-1"]);
  });

  test("retains raw container overflow for the engine finalizer", async () => {
    const root = await workspace();
    const containers = new FakeContainers();
    containers.shellOutput = "😀".repeat(500);
    const executor = new RunnerCommandExecutor(containers);
    const output = await executor.execute({
      ...command("bash", "container", root),
      outputLimitCharacters: 200,
    });

    expect(Array.from(output)).toHaveLength(201);
    expect(output).not.toContain("Tool output truncated");
    expect(output).not.toContain("saved to");

    const cleanup = command("cleanup_execution_environment", "container", root);
    await executor.execute(cleanup);
    expect(
      await executor.execute({
        ...cleanup,
        arguments: { [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true },
        id: "terminal-cleanup",
      }),
    ).toBe("Session execution resources removed.");
  });

  test("keeps bare-metal behavior available", async () => {
    const output = await new RunnerCommandExecutor().execute({
      arguments: { command: "printf bare-metal", timeout: 5 },
      executionEnvironment: "bare_metal",
      id: "bare-command",
      sessionId: "session-1",
      tool: "bash",
      workingDirectory: process.cwd(),
    });

    expect(output).toBe("stdout:\nbare-metal\nExit code: 0");
  });
});
