import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { listProjectFiles } from "../project-files.ts";
import { runScript } from "../script-entry.ts";
import { withTemporaryDirectory } from "./temporary-directory.ts";

const priorExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = priorExitCode;
  vi.restoreAllMocks();
});

async function expectScriptFailure(
  run: () => Promise<number>,
  message: string | RegExp,
): Promise<void> {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;

  await runScript(run);

  expect(error).toHaveBeenCalledWith(
    typeof message === "string" ? message : expect.stringMatching(message),
  );
  expect(process.exitCode).toBe(1);
}

describe("script support", () => {
  test("lists tracked and unignored files that still exist", async () => {
    await withTemporaryDirectory("q-mush-project-files-", async (directory) => {
      const git = Bun.spawn(["git", "init", "--quiet"], { cwd: directory });
      expect(await git.exited).toBe(0);
      await mkdir(join(directory, "nested"));
      await Promise.all([
        writeFile(join(directory, ".gitignore"), "ignored.txt\n"),
        writeFile(join(directory, "tracked.txt"), "tracked\n"),
        writeFile(join(directory, "untracked.txt"), "untracked\n"),
        writeFile(join(directory, "ignored.txt"), "ignored\n"),
        writeFile(join(directory, "nested", "present.txt"), "present\n"),
        writeFile(join(directory, "deleted.txt"), "deleted\n"),
      ]);
      const add = Bun.spawn(
        [
          "git",
          "add",
          ".gitignore",
          "tracked.txt",
          "nested/present.txt",
          "deleted.txt",
        ],
        { cwd: directory },
      );
      expect(await add.exited).toBe(0);
      await rm(join(directory, "deleted.txt"));

      await expect(listProjectFiles(directory)).resolves.toEqual([
        ".gitignore",
        "nested/present.txt",
        "tracked.txt",
        "untracked.txt",
      ]);
    });
  });

  test("reports git listing failures", async () => {
    await withTemporaryDirectory("q-mush-project-files-", async (directory) => {
      await expect(listProjectFiles(directory)).rejects.toThrow(
        /Could not list project files with git:/u,
      );
    });
  });

  test("sets the successful script exit code", async () => {
    process.exitCode = undefined;

    await runScript(() => Promise.resolve(7));

    expect(process.exitCode).toBe(7);
  });

  test("reports a rejected script Error", async () => {
    await expectScriptFailure(
      () => Promise.reject(new Error("script failed")),
      "script failed",
    );
  });

  test("reports a synchronously thrown Error", async () => {
    await expectScriptFailure(() => {
      JSON.parse("not json");
      return Promise.resolve(0);
    }, /JSON/u);
  });
});
