import { describe, expect, test } from "vitest";
import {
  readRunnerCommand,
  RunnerCommandExecutor,
} from "../../runner/runner-command.ts";
import type { RunnerContainerManager } from "../../runner/runner-container.ts";
import type {
  RunnerExecutionEnvironment,
  RunnerToolCommand,
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
    return Promise.resolve("container shell output");
  }
}

function command(
  tool: string,
  executionEnvironment: RunnerExecutionEnvironment = "container",
  workingDirectory = process.cwd(),
): RunnerToolCommand {
  return {
    arguments:
      tool === "bash"
        ? { command: "pwd", timeout: 5 }
        : { path: "/workspace/README.md" },
    executionEnvironment,
    id: `command-${tool}`,
    sessionId: "session-1",
    tool,
    workingDirectory,
  };
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
    const containers = new FakeContainers();
    const executor = new RunnerCommandExecutor(containers);
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
