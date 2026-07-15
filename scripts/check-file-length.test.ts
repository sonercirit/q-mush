import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findFileLengthViolations,
  formatFileLengthViolations,
} from "./check-file-length.ts";

describe("file length check", () => {
  test("flags a file when it reaches 20,000 characters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "q-mush-file-length-"));

    try {
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
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("excludes bun.lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "q-mush-file-length-"));

    try {
      await writeFile(join(directory, "bun.lock"), "x".repeat(20_000));

      const violations = await findFileLengthViolations(directory, ["bun.lock"]);

      expect(violations).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
