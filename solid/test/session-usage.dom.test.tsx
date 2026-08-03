import { afterEach, expect, test } from "vitest";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { queryTestElement } from "./dom-test-helpers.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import {
  DOM_TEST_DISPOSALS,
  mountSessionDetailBody,
} from "./session-dom-test-helpers.tsx";

const USAGE = {
  cacheWriteInputTokens: 200,
  cachedInputTokens: 600,
  inputTokens: 1_000,
  outputTokens: 300,
  reportedStepCount: 2,
  stepCount: 3,
} as const;

afterEach(() => {
  for (const dispose of DOM_TEST_DISPOSALS.splice(0)) dispose();
  document.body.replaceChildren();
});

test("shows whole-session and visible-segment usage with partial coverage", () => {
  const detail = {
    ...TEST_SESSION_DETAIL,
    hasOlderSegments: true,
    segmentTokenUsage: USAGE,
    tokenUsage: USAGE,
  };
  const view = mountSessionDetailBody(
    sessionDetailState(detail),
    DOM_TEST_DISPOSALS,
  );

  const session = queryTestElement(view.container, "[data-session-usage]");
  const segment = queryTestElement(view.container, "[data-segment-usage]");
  for (const output of [session.textContent, segment.textContent]) {
    expect(output).toContain("Input: 1K");
    expect(output).toContain("Output: 300");
    expect(output).toContain("Cached: 600");
    expect(output).toContain("Cache write: 200");
    expect(output).toContain("Cache rate: 60%");
    expect(output).toContain("2 of 3 steps");
  }
});

test("omits cache rate when no reported input exists", () => {
  const usage = {
    ...USAGE,
    cachedInputTokens: 0,
    inputTokens: 0,
    reportedStepCount: 1,
    stepCount: 1,
  };
  const detail = {
    ...TEST_SESSION_DETAIL,
    hasOlderSegments: true,
    segmentTokenUsage: usage,
    tokenUsage: usage,
  };
  const view = mountSessionDetailBody(
    sessionDetailState(detail),
    DOM_TEST_DISPOSALS,
  );

  expect(
    queryTestElement(view.container, "[data-session-usage]").textContent,
  ).not.toContain("Cache rate");
});
