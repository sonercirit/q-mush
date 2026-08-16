import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import "../styles.css";
import { queryTestElement, queryTestTranscript } from "./dom-test-helpers.ts";
import { createSessionDetailReplacement } from "./session-detail-replacement-fixture.tsx";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { mountSessionDetailBody } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

const BROWSER_TEST_DISPOSALS: (() => void)[] = [];
const LARGE_CONTENT = Array.from(
  { length: 36 },
  (_, index) => `Layout line ${String(index)}`,
).join("\n\n");

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
  readonly detail: HTMLDivElement;
  readonly replaceDetail: (detail: AgentSessionDetail) => void;
  readonly toggle: HTMLButtonElement;
  readonly transcript: HTMLUListElement;
} {
  const initial = {
    ...TEST_SESSION_DETAIL,
    messages: [transcriptMessage("initial", "Initial transcript", "user", 2)],
  };
  const reactive = sessionDetailState(initial, [summaryFromDetail(initial)]);
  const replacement = createSessionDetailReplacement();
  const mounted = mountSessionDetailBody(
    reactive,
    BROWSER_TEST_DISPOSALS,
    undefined,
    replacement.render,
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
  const transcript = queryTestTranscript(mounted.container);
  const detail = detailElement;
  const composer = composerElement;
  const toggle = toggleElement;
  return {
    composer,
    detail,
    replaceDetail: replacement.replace,
    toggle,
    transcript,
  };
}

function appendSpacer(height: number): void {
  const spacer = document.createElement("div");
  spacer.style.height = `${String(height)}px`;
  document.body.prepend(spacer);
}

function growSessionHeader(detail: HTMLElement): void {
  const header = detail.firstElementChild;
  if (!(header instanceof HTMLElement)) {
    throw new TypeError("Missing session detail header");
  }
  header.style.paddingBottom = "600px";
}

function setComposerValue(composer: HTMLTextAreaElement, value: string): void {
  composer.value = value;
  composer.style.height = "auto";
  composer.style.height = `${String(composer.scrollHeight)}px`;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

afterEach(() => {
  for (const dispose of BROWSER_TEST_DISPOSALS.splice(0).reverse()) dispose();
  document.body.replaceChildren();
  document.documentElement.style.scrollBehavior = "auto";
});

test("real session layout changes do not move the document or nested transcript", async () => {
  document.documentElement.style.scrollBehavior = "auto";
  appendSpacer(1_000);
  const { composer, detail, replaceDetail, toggle, transcript } =
    renderScrollFixture();
  await nextPaint();
  window.scrollTo(0, detail.offsetTop + 550);
  toggle.click();
  transcript.scrollTop = 0;
  transcript.dispatchEvent(new Event("scroll"));
  const documentTop = window.scrollY;
  const transcriptTop = transcript.scrollTop;

  expect(getComputedStyle(detail).overflowAnchor).toBe("none");
  expect(documentTop).toBeGreaterThan(0);

  const withTranscript = {
    ...TEST_SESSION_DETAIL,
    messages: [
      transcriptMessage("initial", "Initial transcript", "user", 2),
      transcriptMessage("growth", LARGE_CONTENT, "assistant", 3),
    ],
  };
  growSessionHeader(detail);
  replaceDetail(withTranscript);
  await nextPaint();
  expect(window.scrollY, "transcript growth").toBe(documentTop);
  expect(transcript.scrollTop, "nested transcript after growth").toBe(
    transcriptTop,
  );

  replaceDetail({
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
  expect(window.scrollY, "textarea and focus growth").toBe(documentTop);
  expect(transcript.scrollTop, "nested transcript after composer").toBe(
    transcriptTop,
  );
  expect(document.activeElement).toBe(composer);
  expect(composer.selectionStart).toBe(8);
  expect(composer.selectionEnd).toBe(19);
});
