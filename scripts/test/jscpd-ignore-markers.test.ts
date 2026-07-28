import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  findJscpdIgnoreMarkers,
  formatJscpdIgnoreMarkers,
} from "../jscpd-ignore-markers.ts";
import { withTemporaryDirectory } from "./temporary-directory.ts";

const marker = (ending: "end" | "start"): string =>
  ["jscpd", `ignore-${ending}`].join(":");

describe("jscpd ignore marker check", () => {
  test("flags start and end markers in source files", async () => {
    await withTemporaryDirectory("q-mush-jscpd-markers-", async (directory) => {
      await Promise.all([
        writeFile(
          join(directory, "ignored.ts"),
          [
            `const value = 1;`,
            `// ${marker("start")}`,
            `// :${marker("end")}`,
          ].join("\n"),
        ),
        writeFile(
          join(directory, "fixture.html"),
          `<!-- ${marker("start")} -->`,
        ),
        writeFile(join(directory, "clean.tsx"), "export const clean = true;"),
      ]);

      const violations = await findJscpdIgnoreMarkers(directory, [
        "ignored.ts",
        "fixture.html",
        "clean.tsx",
      ]);

      expect(violations).toEqual([
        { line: 2, path: "ignored.ts" },
        { line: 3, path: "ignored.ts" },
      ]);
      expect(formatJscpdIgnoreMarkers(violations)).toContain(
        "Remove every marker and de-duplicate the code instead.",
      );
    });
  });

  test("skips source paths that no longer exist", async () => {
    await withTemporaryDirectory("q-mush-jscpd-markers-", async (directory) => {
      expect(await findJscpdIgnoreMarkers(directory, ["missing.ts"])).toEqual(
        [],
      );
    });
  });
});
