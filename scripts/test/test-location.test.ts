import { describe, expect, test } from "vitest";
import {
  findTestLocationViolations,
  formatTestLocationViolations,
} from "../test-location.ts";

describe("test location check", () => {
  test("flags test files without a test directory at any depth", () => {
    const violations = findTestLocationViolations([
      "test/root.test.ts",
      "apps/control-center/test/routes/session.spec.tsx",
      "packages/runner/src/runner_test.mts",
      "scripts/check-file-length.test.ts",
      "packages/contest/example.test.cts",
      "src/latest.ts",
    ]);

    expect(violations).toEqual([
      "packages/runner/src/runner_test.mts",
      "scripts/check-file-length.test.ts",
      "packages/contest/example.test.cts",
    ]);
    expect(formatTestLocationViolations(violations)).toContain(
      'a directory named "test"',
    );
  });

  test("ignores non-test source files", () => {
    expect(
      findTestLocationViolations([
        "src/index.ts",
        "src/test-support.ts",
        "scripts/testing.ts",
      ]),
    ).toEqual([]);
  });
});
