import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeRunnerTool } from "../runner-tools.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const workspace = useTemporaryDirectories("q-mush-tools-test-");

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

  test("does not let file tools escape the selected workspace", async () => {
    const root = await workspace();

    const error = await captureRejection(
      executeRunnerTool(root, "read", { path: "../secret.txt" }),
    );
    expect(requireError(error).message).toContain(
      "outside the session workspace",
    );
  });

  test("runs bounded bash commands for listing and searching", async () => {
    const root = await workspace();
    await writeFile(join(root, "one.txt"), "alpha\nneedle here\n", "utf8");
    await writeFile(join(root, "two.txt"), "nothing\n", "utf8");

    const commandOutput = await executeRunnerTool(root, "bash", {
      command: "grep -n needle *.txt; pwd",
      timeout: 5,
    });
    expect(commandOutput).toContain("one.txt:2:needle here");
    expect(commandOutput).toContain(root);
    expect(commandOutput).toContain("Exit code: 0");
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

    const error = await captureRejection(
      executeRunnerTool(root, "edit", {
        edits: [
          { newText: "first", oldText: "one two" },
          { newText: "second", oldText: "two three" },
        ],
        path: "message.txt",
      }),
    );

    expect(requireError(error).message).toContain("overlap");
    expect(await readFile(path, "utf8")).toBe("one two three");
  });
});
