import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { listRunnerDirectories } from "../../runner/runner-directories.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-directories-test-");

describe("runner directory browser", () => {
  test("lists only child directories with navigation paths", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "zeta")),
      mkdir(join(root, "Alpha")),
      writeFile(join(root, "notes.txt"), "not a directory", "utf8"),
    ]);

    expect(await listRunnerDirectories(root)).toEqual({
      directories: [
        { name: "Alpha", path: join(root, "Alpha") },
        { name: "zeta", path: join(root, "zeta") },
      ],
      parent: dirname(root),
      path: root,
      truncated: false,
    });
  });

  test("rejects a file as a browsing location", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "notes.txt");
    await writeFile(file, "not a directory", "utf8");

    await expect(listRunnerDirectories(file)).rejects.toThrow(
      "browsing location is not a directory",
    );
  });
});
