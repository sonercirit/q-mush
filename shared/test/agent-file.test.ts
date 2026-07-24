import { expect, test } from "vitest";
import { readRunnerAgentFileOutput } from "../../shared/agent-file.ts";

test("preserves clear runner errors while reading an agent file", () => {
  expect(() =>
    readRunnerAgentFileOutput(
      "Error: Container execution is unavailable: docker was not found",
    ),
  ).toThrow("Container execution is unavailable");
});
