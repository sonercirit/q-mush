import { createSignal, untrack } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionDetailBody } from "../session-detail-body.tsx";
import type { LoadedSessionDetailViewProps } from "../session-detail-view-props.ts";
import { disposeTestViews, queryTestTranscript } from "./dom-test-helpers.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import {
  DOM_TEST_DISPOSALS,
  mountSessionDetailBody,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  disposeTestViews(DOM_TEST_DISPOSALS);
});

function scrollingTranscript() {
  const detail = {
    ...TEST_SESSION_DETAIL,
    messages: [
      transcriptMessage("user-stream", "Initial task", "user", 2),
      transcriptMessage("assistant-stream", "Live", "assistant", 3),
    ],
    status: "running" as const,
  };
  const reactive = sessionDetailState(detail, [summaryFromDetail(detail)]);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  let updateTranscript:
    ((content: string, appendMessage?: boolean) => void) | undefined;
  const mounted = mountSessionDetailBody(
    reactive,
    DOM_TEST_DISPOSALS,
    undefined,
    (props) => {
      const [view, setView] = createSignal<LoadedSessionDetailViewProps>(
        untrack(() => props.view),
      );
      updateTranscript = (content, appendMessage = false) => {
        setView((current) => {
          const messages = appendMessage
            ? [
                ...current.detail.messages,
                transcriptMessage(
                  `assistant-${String(current.detail.messages.length)}`,
                  content,
                  "assistant",
                  current.detail.messages.length + 2,
                ),
              ]
            : current.detail.messages.map((message, index) =>
                index === current.detail.messages.length - 1
                  ? { ...message, content }
                  : message,
              );
          const nextDetail = { ...current.detail, messages };
          return {
            ...current,
            detail: nextDetail,
            state: { ...current.state, detail: nextDetail },
          };
        });
      };
      return <SessionDetailBody {...props} view={view()} />;
    },
  );
  const transcript = queryTestTranscript(mounted.container);
  const toggle = mounted.container.querySelector<HTMLButtonElement>(
    "[data-scroll-lock-toggle='true']",
  );
  if (toggle === null || updateTranscript === undefined) {
    throw new TypeError("Missing scroll test controls");
  }
  let scrollHeight = 500;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  frames.length = 0;
  return {
    expectFrames: (count: number) => {
      expect(frames).toHaveLength(count);
    },
    expectLocked: (enabled: boolean) => {
      expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
    },
    expectTop: (position: number) => {
      expect(transcript.scrollTop).toBe(position);
    },
    paintAfterLayout: (height: number) => {
      scrollHeight = height;
      frames.shift()?.(0);
    },
    scrollTo: (position: number) => {
      transcript.scrollTop = position;
      transcript.dispatchEvent(new Event("scroll"));
    },
    stream: updateTranscript,
  };
}

test("stays locked to the bottom while assistant content streams", () => {
  const view = scrollingTranscript();
  view.scrollTo(360);
  view.stream("Live output grows");
  view.expectFrames(1);
  view.paintAfterLayout(650);
  view.expectTop(650);

  view.stream("Live output grows again");
  view.paintAfterLayout(800);
  view.expectTop(800);
  view.expectLocked(true);
});

test("scrolling up releases the lock before a queued scroll can snap back", () => {
  const view = scrollingTranscript();
  view.scrollTo(400);
  view.stream("A queued update");
  view.expectFrames(1);

  view.scrollTo(200);
  view.paintAfterLayout(650);
  view.expectTop(200);
  view.expectLocked(false);

  view.stream("More output while reading above");
  view.expectFrames(0);
  view.expectTop(200);
});

test("scrolling back to the bottom restores streaming scroll lock", () => {
  const view = scrollingTranscript();
  view.scrollTo(200);
  view.stream("Output ignored while unlocked");
  view.expectFrames(0);

  view.scrollTo(400);
  view.expectLocked(true);
  view.stream("Output followed after relocking");
  view.paintAfterLayout(700);
  view.expectTop(700);
});

test("scroll lock waits for transcript layout before using its new height", () => {
  const view = scrollingTranscript();
  view.stream("A newly rendered message", true);

  view.expectTop(0);
  view.expectFrames(1);
  view.paintAfterLayout(900);
  view.expectTop(900);
});
