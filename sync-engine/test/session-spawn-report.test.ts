import { describe, expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import {
  TEST_SESSION_DETAIL,
  testSessionMessage,
} from "../../shared/test/session-fixtures.ts";
import { spawnedSessionReport } from "../session-spawn-report.ts";

function reportWithStatus(
  messages: readonly AgentSessionMessage[],
  status: "completed" | "failed",
): string | undefined {
  return spawnedSessionReport(
    { ...TEST_SESSION_DETAIL, messages, status },
    "parent-1",
  )?.content;
}

function completedReport(
  messages: readonly AgentSessionMessage[],
): string | undefined {
  return reportWithStatus(messages, "completed");
}

function failedReport(
  messages: readonly AgentSessionMessage[],
): string | undefined {
  return reportWithStatus(messages, "failed");
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

  test("redacts generic and provider-prefixed assignment names", () => {
    const secrets = {
      camel: "camel-secret-value",
      credential: "credential-secret-value",
      generic: "generic-secret-value",
      openai: "openai-secret-value",
      privateKey: "private-key-secret-value",
    } as const;
    const content = failedReport([
      testSessionMessage(
        "message-secret-assignments",
        `OPENAI_API_KEY=${secrets.openai} GENERIC_ACCESS_TOKEN='${secrets.generic}' credential: "${secrets.credential}" clientSecret=${secrets.camel} private-key=${secrets.privateKey}`,
        "error",
        1,
      ),
    ]);

    expect(content).toContain("OPENAI_API_KEY=[redacted]");
    expect(content).toContain("GENERIC_ACCESS_TOKEN=[redacted]");
    expect(content).toContain("credential=[redacted]");
    expect(content).toContain("clientSecret=[redacted]");
    expect(content).toContain("private-key=[redacted]");
    for (const secret of Object.values(secrets)) {
      expect(content).not.toContain(secret);
    }
  });

  test("always includes the terminal error after a partial failed answer", () => {
    const content = failedReport([
      testSessionMessage(
        "message-partial",
        "Partial work before failure",
        "assistant",
        1,
      ),
      testSessionMessage(
        "message-failure",
        "Session failed: credential_rate_limited",
        "error",
        2,
      ),
    ]);

    expect(content).toContain('"error"');
    expect(content).toContain("credential_rate_limited");
    expect(content).toContain("Partial work before failure");
  });

  test.each([
    {
      error: {
        content: "Session failed: server interrupted the current attempt",
        createdAt: 4,
        id: "message-unbound-error",
        turnId: null,
      },
      title:
        "uses an unbound terminal failure instead of an earlier generation",
      turn: { endedAt: 4, id: "turn-1", startedAt: 3 },
    },
    {
      error: {
        content: "Session failed: credential_rate_limited",
        createdAt: 3,
        id: "message-current",
        turnId: "turn-1",
      },
      title: "uses only the current attempt's final error",
      turn: { endedAt: 3, id: "turn-1", startedAt: 2 },
    },
  ])("$title", ({ error, turn }) => {
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
              error.id,
              error.content,
              "error",
              error.createdAt,
            ),
            turnId: error.turnId,
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
            executionGeneration: 1,
            ...turn,
          },
        ],
      },
      "parent-1",
    )?.content;

    expect(content).toContain(error.content.replace("Session failed: ", ""));
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
