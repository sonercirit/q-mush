import { expect, test } from "vitest";
import { readContinuation } from "../runner/runner-read-continuation.ts";

test.each([
  ["abc\nx", 3, "abc\n"],
  ["😀😀\n🦄", 2, "😀😀\n"],
])(
  "retains evidence of omitted content when no continuation marker fits",
  (content, maximum, expected) => {
    expect(readContinuation(content, 1, 1, maximum)).toBe(expected);
  },
);
