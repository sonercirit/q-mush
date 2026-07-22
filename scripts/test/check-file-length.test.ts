import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  findFileLengthViolations,
  formatFileLengthViolations,
} from "../check-file-length.ts";

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "q-mush-file-length-"));

  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("file length check", () => {
  test("flags a file when it reaches 20,000 characters", async () => {
    await withTemporaryDirectory(async (directory) => {
      await Promise.all([
        writeFile(join(directory, "under-limit.txt"), "😀".repeat(19_999)),
        writeFile(join(directory, "at-limit.txt"), "😀".repeat(20_000)),
      ]);

      const violations = await findFileLengthViolations(directory, [
        "under-limit.txt",
        "at-limit.txt",
      ]);

      expect(violations).toEqual([
        { characterCount: 20_000, path: "at-limit.txt" },
      ]);
      expect(formatFileLengthViolations(violations)).toContain(
        "Split or condense each listed file",
      );
    });
  });

  test("excludes bun.lock and the Drizzle migrations directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "drizzle", "meta"), { recursive: true });
      const excludedPaths = [
        "bun.lock",
        "drizzle/0001_migration.sql",
        "drizzle/meta/snapshot.json",
      ];
      await Promise.all(
        excludedPaths.map((path) =>
          writeFile(join(directory, path), "x".repeat(20_000)),
        ),
      );

      expect(await findFileLengthViolations(directory, excludedPaths)).toEqual(
        [],
      );
    });
  });
});
