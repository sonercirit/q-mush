import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeRunnerTool } from "../../runner/runner-tools.ts";
import { openSecureRunnerPath } from "../../runner/runner-workspace.ts";
import { MAXIMUM_AGENT_ATTACHMENT_BYTES } from "../../shared/agent-attachments.ts";
import { AGENT_TOOLS } from "../../shared/agent-tools.ts";
import {
  observeRunnerRejection,
  requireRunnerError,
} from "./promise-test-helpers.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const workspace = useTemporaryDirectories("q-mush-tools-test-");

function executeBash(
  root: string,
  command: string,
  timeout: number,
): Promise<string> {
  return executeRunnerTool(root, "bash", { command, timeout });
}

async function explainOutput(root: string): Promise<unknown> {
  const output = await executeRunnerTool(root, "explain_file", {
    path: "diagram.png",
  });
  return JSON.parse(output);
}

async function captureToolError(
  ...parameters: Parameters<typeof executeRunnerTool>
): Promise<Error> {
  return requireRunnerError(
    await observeRunnerRejection(executeRunnerTool(...parameters)),
  );
}

interface SwappedPathFixture {
  readonly liveDirectory: string;
  readonly outsideDirectory: string;
  readonly retainedDirectory: string;
  readonly root: string;
}

async function swappedPathFixture(): Promise<SwappedPathFixture> {
  const root = await workspace();
  const liveDirectory = join(root, "live");
  const retainedDirectory = join(root, "retained");
  const outsideDirectory = await workspace();
  await mkdir(liveDirectory);
  await writeFile(join(liveDirectory, "diagram.png"), "contained");
  await writeFile(join(outsideDirectory, "diagram.png"), "outside");
  return { liveDirectory, outsideDirectory, retainedDirectory, root };
}

async function swapPath(
  liveDirectory: string,
  retainedDirectory: string,
  outsideDirectory: string,
): Promise<void> {
  await rename(liveDirectory, retainedDirectory);
  await symlink(outsideDirectory, liveDirectory);
}

async function explainWorkspace(): Promise<string> {
  const root = await workspace();
  await writeFile(join(root, "diagram.png"), Uint8Array.from([1, 2, 3]));
  return root;
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

  test("loads explainable files inside and outside the workspace", async () => {
    const root = await explainWorkspace();
    const outside = await workspace();
    await writeFile(join(outside, "secret.png"), Uint8Array.from([4, 5]));

    const output = await explainOutput(root);
    const outsideOutput = await executeRunnerTool(root, "explain_file", {
      path: join(outside, "secret.png"),
    });

    expect(output).toEqual({
      data: Uint8Array.from([1, 2, 3]).toBase64(),
      mediaType: "image/png",
      name: "diagram.png",
    });
    expect(JSON.parse(outsideOutput)).toEqual({
      data: Uint8Array.from([4, 5]).toBase64(),
      mediaType: "image/png",
      name: "secret.png",
    });
  });

  test("binds Darwin descriptor validation to the opened descriptor", async () => {
    const fixture = await swappedPathFixture();
    const { liveDirectory, outsideDirectory, retainedDirectory, root } =
      fixture;

    let openCount = 0;
    let openedFileDescriptor: number | undefined;
    let validatedFileDescriptor: number | undefined;
    let openedPath: string | undefined;
    const error = requireRunnerError(
      await observeRunnerRejection(
        openSecureRunnerPath(root, "live/diagram.png", {
          darwinPathFromHandle: (handle) => {
            validatedFileDescriptor = handle.fd;
            return realpath(`/proc/self/fd/${String(handle.fd)}`);
          },
          openPath: async (...parameters) => {
            openCount += 1;
            openedPath = parameters[0].toString();
            await swapPath(liveDirectory, retainedDirectory, outsideDirectory);
            const handle = await open(...parameters);
            openedFileDescriptor = handle.fd;
            return handle;
          },
          platform: "darwin",
        }),
      ),
    );

    expect(openCount).toBe(1);
    expect(openedFileDescriptor).toBe(validatedFileDescriptor);
    expect(openedPath).toBe(join(liveDirectory, "diagram.png"));
    expect(error.message).toContain("changed while it was being validated");
  });

  test("keeps reads on the opened object during a path swap", async () => {
    const fixture = await swappedPathFixture();

    const { handle, stats } = await openSecureRunnerPath(
      fixture.root,
      "live/diagram.png",
    );
    await swapPath(
      fixture.liveDirectory,
      fixture.retainedDirectory,
      fixture.outsideDirectory,
    );

    try {
      expect(stats.isFile()).toBe(true);
      expect((await handle.readFile()).toString()).toBe("contained");
    } finally {
      await handle.close();
    }
  });

  test("rejects non-regular and oversized explain-file inputs", async () => {
    const root = await workspace();
    const fifo = join(root, "pipe.png");
    const oversized = join(root, "oversized.png");
    await executeBash(root, `mkfifo ${JSON.stringify(fifo)}`, 5);
    await writeFile(
      oversized,
      Buffer.alloc(MAXIMUM_AGENT_ATTACHMENT_BYTES + 1),
    );

    const [fifoError, oversizedError] = await Promise.all([
      captureToolError(root, "explain_file", { path: fifo }),
      captureToolError(root, "explain_file", { path: oversized }),
    ]);

    expect(fifoError.message).toContain("not a file");
    expect(oversizedError.message).toContain("exceeds");
    await unlink(fifo);
  });

  test("validates optional explain-file prompts in the runner", async () => {
    const root = await explainWorkspace();

    const wrongType = await captureToolError(root, "explain_file", {
      path: "diagram.png",
      prompt: 123,
    });
    const tooLong = await captureToolError(root, "explain_file", {
      path: "diagram.png",
      prompt: "x".repeat(4_001),
    });

    expect(wrongType.message).toContain("prompt must be a string");
    expect(tooLong.message).toContain("prompt must be a string");
  });

  test("reads and writes sibling paths outside the workspace", async () => {
    const outside = await workspace();
    const root = join(outside, "workspace");
    await mkdir(root);
    await writeFile(join(outside, "HANDOFF.md"), "handoff notes\n", "utf8");

    expect(
      await executeRunnerTool(root, "read", { path: "../HANDOFF.md" }),
    ).toBe("handoff notes\n");
    expect(
      await executeRunnerTool(root, "write", {
        content: "shared state\n",
        path: join(outside, "notes.txt"),
      }),
    ).toContain("Wrote 13 bytes");
    expect(await readFile(join(outside, "notes.txt"), "utf8")).toBe(
      "shared state\n",
    );
  });

  test("rejects incomplete tool calls", async () => {
    const root = await workspace();
    const missingError = await captureToolError(root, "read", {
      path: "missing-file.txt",
    });
    const timeoutError = await captureToolError(root, "bash", {
      command: "printf completed",
    });
    const bashDefinition = AGENT_TOOLS.find(
      ({ function: definition }) => definition.name === "bash",
    );

    expect(missingError.message).toContain("ENOENT");
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
