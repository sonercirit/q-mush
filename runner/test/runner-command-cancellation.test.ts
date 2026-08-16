import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeRunnerCommand } from "../runner-command.ts";
import { executeRunnerToolResult } from "../runner-tools.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories(
  "q-mush-command-cancellation-test-",
);
const DESCENDANT_MARKER = ".runner-descendant-ready";
const DESCENDANT_COMMAND =
  `/bin/sh -c "/bin/sh -c 'printf descendant-ready; ` +
  `printf ready > ${DESCENDANT_MARKER}; sleep 10; :' & wait" & wait`;
const QUICK_TERMINATION_MILLISECONDS = 750;
const TIMEOUT_SECONDS = 1;

function cancellableShell(options: {
  readonly command: string;
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly timeout: number;
}): Promise<string> {
  const selected = {
    arguments: { command: options.command, timeout: options.timeout },
    executionEnvironment: "bare_metal" as const,
    id: "shell-cancellation-command",
    sessionId: "session-cancellation",
    tool: "bash",
    workingDirectory: options.root,
  };
  return executeRunnerCommand(selected, options.signal);
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
    if (await Bun.file(path).exists()) return;
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

function fencedShellExecution(
  root: string,
  controller: AbortController,
  shellCalls: string[],
): Promise<unknown> {
  return executeRunnerToolResult(
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
}

describe("runner command cancellation", () => {
  test("stops a shell descendant and grandchild retaining pipes", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    const result = cancellableShell({
      command: DESCENDANT_COMMAND,
      root,
      signal: controller.signal,
      timeout: 60,
    });

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
      cancellableShell({
        command: DESCENDANT_COMMAND,
        root,
        timeout: TIMEOUT_SECONDS,
      }),
      TIMEOUT_SECONDS * 1_000 + QUICK_TERMINATION_MILLISECONDS,
    );

    expect(await Bun.file(join(root, DESCENDANT_MARKER)).exists()).toBe(true);
    expect(result).toContain("stdout:\ndescendant-ready");
    expect(result).toContain(
      `Timed out after ${String(TIMEOUT_SECONDS)} seconds.`,
    );
    expect(result).not.toContain("stopped");
  });

  test.each(["before", "after"] as const)(
    "fences result execution when canceled %s dispatch",
    async (timing) => {
      const controller = new AbortController();
      const shellCalls: string[] = [];
      if (timing === "before") controller.abort();
      const result = fencedShellExecution(
        await temporaryDirectory(),
        controller,
        shellCalls,
      );
      if (timing === "after") controller.abort();

      await expect(result).rejects.toThrow("The runner command was stopped");
      expect(shellCalls).toEqual([]);
    },
  );

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
});
