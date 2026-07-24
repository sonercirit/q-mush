import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  executeRunnerToolResult,
  type RunnerToolStream,
} from "../../runner/runner-tools.ts";
import { AGENT_TOOLS } from "../../shared/agent-tools.ts";
import type { RunnerToolOutputDelta } from "../../shared/runner-command-broker.ts";
import {
  observeRunnerRejection,
  requireRunnerError,
} from "./promise-test-helpers.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const workspace = useTemporaryDirectories("q-mush-tools-test-");

async function executeRunnerTool(
  workingDirectory: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  stream?: RunnerToolStream,
): Promise<string> {
  return (
    await executeRunnerToolResult(
      workingDirectory,
      name,
      arguments_,
      signal,
      stream,
    )
  ).output;
}

function executeBash(
  root: string,
  command: string,
  timeout: number,
): Promise<string> {
  return executeRunnerTool(root, "bash", { command, timeout });
}

async function captureToolError(
  ...parameters: Parameters<typeof executeRunnerTool>
): Promise<Error> {
  return requireRunnerError(
    await observeRunnerRejection(executeRunnerTool(...parameters)),
  );
}

describe("runner tools", () => {
  test("reads, writes, and applies Pi-style batched edits in the workspace", async () => {
    const root = await workspace();

    expect(
      await executeRunnerTool(root, "write", {
        content: "hello mushroom\nsecond line\n",
        path: "notes/message.txt",
      }),
    ).toContain("Wrote 27 bytes");
    expect(
      await executeRunnerTool(root, "read", {
        path: "notes/message.txt",
      }),
    ).toBe("hello mushroom\nsecond line\n");
    expect(
      await executeRunnerTool(root, "edit", {
        edits: [
          { newText: "swarm", oldText: "mushroom" },
          { newText: "next", oldText: "second" },
        ],
        path: "notes/message.txt",
      }),
    ).toContain("replaced 2 block(s)");
    expect(await readFile(join(root, "notes/message.txt"), "utf8")).toBe(
      "hello swarm\nnext line\n",
    );
  });

  test("rejects unsafe or incomplete tool calls", async () => {
    const root = await workspace();
    const pathError = await captureToolError(root, "read", {
      path: "../secret.txt",
    });
    const timeoutError = await captureToolError(root, "bash", {
      command: "printf completed",
    });
    const bashDefinition = AGENT_TOOLS.find(
      ({ function: definition }) => definition.name === "bash",
    );

    expect(pathError.message).toContain("outside the session workspace");
    expect(timeoutError.message).toContain("timeout");
    expect(bashDefinition?.function.parameters.required).toEqual([
      "command",
      "timeout",
    ]);
  });

  test("runs bounded bash commands for listing and searching", async () => {
    const root = await workspace();
    await writeFile(join(root, "one.txt"), "alpha\nneedle here\n", "utf8");
    await writeFile(join(root, "two.txt"), "nothing\n", "utf8");

    const commandOutput = await executeBash(
      root,
      "grep -n needle *.txt; pwd",
      5,
    );
    expect(commandOutput).toContain("one.txt:2:needle here");
    expect(commandOutput).toContain(root);
    expect(commandOutput).toContain("Exit code: 0");
  });

  test("accepts explicit shell timeouts longer than five minutes", async () => {
    const root = await workspace();
    const output = await executeBash(root, "printf completed", 301);

    expect(output).toContain("completed");
    expect(output).toContain("Exit code: 0");
  });

  test("runs independent base tools through the parallel wrapper", async () => {
    const root = await workspace();

    const output = await executeRunnerTool(root, "parallel", {
      tool_uses: [
        {
          parameters: { content: "first", path: "first.txt" },
          recipient_name: "write",
        },
        {
          parameters: { content: "second", path: "second.txt" },
          recipient_name: "write",
        },
      ],
    });

    expect(output).toContain('"recipient_name": "write"');
    expect(output).toContain("Wrote 5 bytes to first.txt");
    expect(output).toContain("Wrote 6 bytes to second.txt");
    expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first");
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second");
  });

  test("streams interleaved parallel bash output through the wrapper", async () => {
    const root = await workspace();
    const streamed: Omit<RunnerToolOutputDelta, "sequence">[] = [];
    const result = await executeRunnerToolResult(
      root,
      "parallel",
      {
        tool_uses: [
          {
            parameters: {
              command: "printf first-out; printf first-error >&2",
              timeout: 5,
            },
            recipient_name: "bash",
          },
          {
            parameters: { command: "exit 7", timeout: 5 },
            recipient_name: "bash",
          },
        ],
      },
      undefined,
      (delta) => streamed.push(delta),
    );

    expect(streamed.filter(({ channel }) => channel === "stdout")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "first-out" }),
      ]),
    );
    expect(streamed.filter(({ channel }) => channel === "stderr")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "first-error" }),
      ]),
    );
    expect(result.output).toContain('"output": "Exit code: 7"');
    expect(result.state).toBe("failed");
  });

  test("rejects overlapping edits without changing the file", async () => {
    const root = await workspace();
    const path = join(root, "message.txt");
    await writeFile(path, "one two three", "utf8");

    const error = await observeRunnerRejection(
      executeRunnerTool(root, "edit", {
        edits: [
          { newText: "first", oldText: "one two" },
          { newText: "second", oldText: "two three" },
        ],
        path: "message.txt",
      }),
    );

    expect(requireRunnerError(error).message).toContain("overlap");
    expect(await readFile(path, "utf8")).toBe("one two three");
  });
});
