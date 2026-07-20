import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRunnerTool } from "../runner-tools.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "q-mush-tools-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("runner tools", () => {
  test("reads, writes, and exactly edits files inside the workspace", async () => {
    const root = await workspace();

    expect(
      await executeRunnerTool(root, "write_file", {
        content: "hello mushroom\n",
        path: "notes/message.txt",
      }),
    ).toContain("Wrote 15 bytes");
    expect(
      await executeRunnerTool(root, "read_file", {
        path: "notes/message.txt",
      }),
    ).toBe("hello mushroom\n");
    expect(
      await executeRunnerTool(root, "edit_file", {
        newText: "swarm",
        oldText: "mushroom",
        path: "notes/message.txt",
      }),
    ).toContain("Updated notes/message.txt");
    expect(await readFile(join(root, "notes/message.txt"), "utf8")).toBe(
      "hello swarm\n",
    );
  });

  test("does not let file tools escape the selected workspace", async () => {
    const root = await workspace();

    const error = await captureRejection(
      executeRunnerTool(root, "read_file", { path: "../secret.txt" }),
    );
    expect(requireError(error).message).toContain(
      "outside the session workspace",
    );
  });

  test("searches files and runs bounded shell commands", async () => {
    const root = await workspace();
    await writeFile(join(root, "one.txt"), "alpha\nneedle here\n", "utf8");
    await writeFile(join(root, "two.txt"), "nothing\n", "utf8");

    expect(
      await executeRunnerTool(root, "search_files", {
        path: ".",
        query: "needle",
      }),
    ).toContain("one.txt:2:needle here");
    const commandOutput = await executeRunnerTool(root, "run_command", {
      command: "printf 'working'; pwd",
      timeoutSeconds: 5,
    });
    expect(commandOutput).toContain("working");
    expect(commandOutput).toContain(root);
    expect(commandOutput).toContain("Exit code: 0");
  });
});
