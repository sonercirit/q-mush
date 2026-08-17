import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionController } from "../session-controller.ts";
import "../styles.css";
import { queryTestElement, queryTestTranscript } from "./dom-test-helpers.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

const BROWSER_TEST_DISPOSALS: (() => void)[] = [];
const LARGE_CONTENT = Array.from(
  { length: 36 },
  (_, index) => `Layout line ${String(index)}`,
).join("\n\n");
const INITIAL_DETAIL: AgentSessionDetail = {
  ...TEST_SESSION_DETAIL,
  messages: [transcriptMessage("initial", "Initial transcript", "user", 2)],
  status: "running",
};

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

function renderScrollFixture(): {
  readonly composer: HTMLTextAreaElement;
  readonly controller: SessionController;
  readonly detail: HTMLDivElement;
  readonly toggle: HTMLButtonElement;
  readonly transcript: HTMLUListElement;
} {
  const mounted = mountTestSessionDetail(
    INITIAL_DETAIL,
    BROWSER_TEST_DISPOSALS,
  );
  const detailElement = queryTestElement(
    mounted.container,
    "[data-session-detail-view='true']",
  );
  const composerElement = queryTestElement(
    mounted.container,
    "[data-session-composer='true'] textarea",
  );
  const toggleElement = queryTestElement(
    mounted.container,
    "[data-scroll-lock-toggle='true']",
  );
  if (
    !(detailElement instanceof HTMLDivElement) ||
    !(composerElement instanceof HTMLTextAreaElement) ||
    !(toggleElement instanceof HTMLButtonElement)
  ) {
    throw new TypeError("Invalid browser scroll regression fixture");
  }
  return {
    composer: composerElement,
    controller: mounted.controller,
    detail: detailElement,
    toggle: toggleElement,
    transcript: queryTestTranscript(mounted.container),
  };
}

function setComposerValue(composer: HTMLTextAreaElement, value: string): void {
  composer.value = value;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  while (BROWSER_TEST_DISPOSALS.length > 0) {
    BROWSER_TEST_DISPOSALS.pop()?.();
  }
  document.documentElement.style.scrollBehavior = "auto";
});

test("real session layout changes do not move the document or nested transcript", async () => {
  document.documentElement.style.scrollBehavior = "auto";
  const { composer, controller, detail, toggle, transcript } =
    renderScrollFixture();
  await nextPaint();
  window.scrollTo(0, 200);
  toggle.click();
  transcript.scrollTop = 0;
  transcript.dispatchEvent(new Event("scroll"));
  const documentTop = window.scrollY;
  const transcriptTop = transcript.scrollTop;

  expect(getComputedStyle(detail).overflowAnchor).toBe("none");
  expect(documentTop).toBeGreaterThan(0);

  const withTranscript: AgentSessionDetail = {
    ...INITIAL_DETAIL,
    tokenUsage: {
      cacheWriteInputTokens: 12_000,
      cachedInputTokens: 95_000,
      inputTokens: 123_456,
      lastInputTokens: 12_345,
      outputTokens: 12_345,
      reportedStepCount: 11,
      stepCount: 12,
    },
  };
  controller.applyDetail(withTranscript);
  controller.applyStreamBatch({
    type: "stream_batch",
    updates: [
      {
        content: LARGE_CONTENT,
        sessionId: withTranscript.id,
        streamId: "scroll-regression-stream",
        thinking: "",
        type: "session_delta",
      },
      {
        entry: {
          arguments: "",
          callId: "scroll-regression-tool",
          index: 0,
          name: "bash",
          sequence: 2,
          sessionId: withTranscript.id,
          state: "running",
          stderr: "",
          stdout: LARGE_CONTENT,
          streamId: "scroll-regression-stream",
        },
        terminal: false,
        type: "tool_update",
      },
    ],
  });
  await nextPaint();
  expect(window.scrollY, "live model/tool and usage growth").toBe(documentTop);
  expect(transcript.scrollTop, "nested transcript after growth").toBe(
    transcriptTop,
  );

  controller.applyDetail({
    ...withTranscript,
    agentFile: { content: LARGE_CONTENT, name: "AGENTS.md" },
  });
  await nextPaint();
  expect(window.scrollY, "agent-file growth").toBe(documentTop);
  expect(transcript.scrollTop, "nested transcript after agent file").toBe(
    transcriptTop,
  );

  setComposerValue(composer, LARGE_CONTENT);
  composer.setSelectionRange(8, 19);
  composer.focus({ preventScroll: true });
  await nextPaint();
  expect(window.scrollY, "composer input and focus").toBe(documentTop);
  expect(transcript.scrollTop, "nested transcript after composer").toBe(
    transcriptTop,
  );
  expect(document.activeElement).toBe(composer);
  expect(composer.selectionStart).toBe(8);
  expect(composer.selectionEnd).toBe(19);
});
