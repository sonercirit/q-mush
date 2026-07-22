import { expect, test } from "vitest";
import {
  findRawHtmlFileViolations,
  formatRawHtmlFileViolations,
} from "../raw-html-files.ts";

test("raw HTML files are limited to tests and fixtures", () => {
  const violations = findRawHtmlFileViolations([
    "index.html",
    "public/shell.HTM",
    "src/legacy.xhtml",
    "src/page.tsx",
    "src/test/page.html",
    "test/browser/shell.html",
    "src/fixtures/provider-response.html",
  ]);

  expect(violations).toEqual([
    "index.html",
    "public/shell.HTM",
    "src/legacy.xhtml",
  ]);
  expect(formatRawHtmlFileViolations(violations)).toContain(
    "Migrate application markup to TSX instead.",
  );
});
