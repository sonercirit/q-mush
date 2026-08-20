import { expect, test } from "vitest";
import { readContinuation } from "../runner/runner-read-continuation.ts";
import { unicodeCharacterCount } from "../shared/tool-output-limits.ts";

test.each([
  ["abc\nx", 3, "abc\n"],
  ["abc\nx", 4, "abc\n\n"],
  ["😀😀\n🦄", 2, "😀😀\n"],
  ["😀😀\n🦄", 3, "😀😀\n\n"],
])(
  "retains evidence of omitted content when no continuation marker fits",
  (content, maximum, expected) => {
    expect(readContinuation(content, 1, 1, maximum)).toBe(expected);
  },
);

test("does not draw a bounded fallback from beyond the requested lines", () => {
  const result = readContinuation("a\nSECRET", 1, 1, 2);
  expect(result).toBe("a\n\n");
  expect(result).not.toContain("SECRET");
});

test("signals overflow when a requested line nearly fills the bound", () => {
  const maximum = 20_000;
  const result = readContinuation(
    `${"x".repeat(19_950)}\nSECRET-LINE-2\nSECRET-LINE-3`,
    1,
    1,
    maximum,
  );

  expect(unicodeCharacterCount(result)).toBe(maximum + 1);
  expect(result).not.toContain("SECRET");
});
