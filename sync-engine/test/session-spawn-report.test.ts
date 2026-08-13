import { describe, expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import {
  TEST_SESSION_DETAIL,
  testSessionMessage,
} from "../../shared/test/session-fixtures.ts";
import { spawnedSessionReport } from "../session-spawn-report.ts";

function completedReport(
  messages: readonly AgentSessionMessage[],
): string | undefined {
  return spawnedSessionReport(
    { ...TEST_SESSION_DETAIL, messages, status: "completed" },
    "parent-1",
  )?.content;
}

function completedReportWithError(
  errorContent: string,
  errorBeforeAnswer: boolean,
): string | undefined {
  const answer = testSessionMessage(
    "message-answer",
    "Full answer",
    "assistant",
    2,
  );
  const error = testSessionMessage("message-error", errorContent, "error", 1);
  return completedReport(
    errorBeforeAnswer ? [error, answer] : [answer, { ...error, createdAt: 3 }],
  );
}

describe("spawned session reports", () => {
  test("appends a truncation notice that follows the terminal answer", () => {
    const content = completedReport([
      testSessionMessage("message-1", "Summarize the repository", "user", 1),
      testSessionMessage("message-2", "Partial answer", "assistant", 2),
      testSessionMessage(
        "message-3",
        "The response was truncated: it reached the maximum output tokens.",
        "error",
        3,
      ),
    ]);

    // The parent must see that the child's answer was cut short instead of
    // treating the partial content as a finished result.
    expect(content).toContain("Partial answer");
    expect(content).toContain("truncated");
  });

  test.each([
    {
      errorBeforeAnswer: false,
      errorContent: "Unrelated status error",
      title: "does not append an unrelated error after the terminal answer",
    },
    {
      errorBeforeAnswer: true,
      errorContent: "A transient earlier failure",
      title: "ignores error notices that precede the terminal answer",
    },
  ])("$title", ({ errorBeforeAnswer, errorContent }) => {
    const content = completedReportWithError(errorContent, errorBeforeAnswer);

    expect(content).toContain("Full answer");
    expect(content).not.toContain(errorContent);
  });
});
