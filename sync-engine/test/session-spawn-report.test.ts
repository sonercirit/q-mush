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
  test("includes generation, stopped status, and a sanitized concise message", () => {
    const content = spawnedSessionReport(
      {
        ...TEST_SESSION_DETAIL,
        generation: 3,
        messages: [
          testSessionMessage(
            "message-secret",
            `Stopped\u0085with authorization=Bearer ${"s".repeat(32)} api_key: "${"k".repeat(32)}" github_pat_${"g".repeat(24)} ${"x".repeat(2_100)}`,
            "error",
            1,
          ),
        ],
        status: "stopped",
      },
      "parent-1",
    )?.content;

    expect(content).toContain('"generation": 3');
    expect(content).toContain('"status": "stopped"');
    expect(content).toContain("authorization=[redacted]");
    expect(content).not.toContain("\u0085");
    expect(content).not.toContain("Bearer");
    expect(content).not.toContain("s".repeat(32));
    expect(content).not.toContain("k".repeat(32));
    expect(content).not.toContain("github_pat_");
    expect(content?.length).toBeLessThan(2_300);
  });

  test("uses only the current attempt's final error", () => {
    const content = spawnedSessionReport(
      {
        ...TEST_SESSION_DETAIL,
        generation: 1,
        messages: [
          {
            ...testSessionMessage(
              "message-old",
              "Old successful answer",
              "assistant",
              1,
            ),
            turnId: "turn-0",
          },
          {
            ...testSessionMessage(
              "message-current",
              "Session failed: credential_rate_limited",
              "error",
              3,
            ),
            turnId: "turn-1",
          },
        ],
        status: "failed",
        turns: [
          {
            boundaryMessageId: "message-old",
            endedAt: 1,
            executionGeneration: 0,
            id: "turn-0",
            startedAt: 0,
          },
          {
            boundaryMessageId: null,
            endedAt: 3,
            executionGeneration: 1,
            id: "turn-1",
            startedAt: 2,
          },
        ],
      },
      "parent-1",
    )?.content;

    expect(content).toContain("credential_rate_limited");
    expect(content).not.toContain("Old successful answer");
  });

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
