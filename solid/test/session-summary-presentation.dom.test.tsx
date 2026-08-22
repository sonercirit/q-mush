import { expect, test } from "vitest";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { statusBadge } from "../session-summary-presentation.tsx";
import { mountTestView, queryTestElement } from "./dom-test-helpers.ts";

function badgeLabel(
  status: AgentSessionSummary["status"],
  pendingQuestions: AgentSessionSummary["pendingQuestions"] = null,
): string | null {
  const disposals: (() => void)[] = [];
  const container = mountTestView(
    () => statusBadge({ pendingQuestions, runnerRequired: false, status }),
    disposals,
  );
  const label = queryTestElement(container, ".rounded-full").textContent;
  for (const dispose of disposals) dispose();
  return label;
}

test("labels idle attempts Ready, terminal success Completed, and input pauses non-final", () => {
  expect(badgeLabel("idle")).toBe("Ready");
  expect(badgeLabel("completed")).toBe("Completed");
  expect(
    badgeLabel("paused", {
      createdAt: 1,
      executionGeneration: 0,
      id: "questions-1",
      questions: [
        {
          id: "decision",
          maxLength: 50,
          prompt: "Which path?",
          type: "free_text",
        },
      ],
      toolCallId: "call-questions",
    }),
  ).toBe("Waiting for answers");
});
