import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import { disposeTestViews, queryTestTranscript } from "./dom-test-helpers.ts";
import { defineElementSize } from "./element-size-test-helpers.ts";
import { createSessionDetailReplacement } from "./session-detail-replacement-fixture.tsx";
import { sessionDetailState } from "./session-detail-test-state.ts";
import {
  DOM_TEST_DISPOSALS,
  mountSessionDetailBody,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  expectScrollTestPaint,
  type SessionScrollTestView,
  unlockScrollTestView,
} from "./session-scroll-test-view.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  disposeTestViews(DOM_TEST_DISPOSALS);
});

function scrollingTranscript(): SessionScrollTestView {
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
  const replacement = createSessionDetailReplacement();
  const mounted = mountSessionDetailBody(
    reactive,
    DOM_TEST_DISPOSALS,
    undefined,
    replacement.render,
  );
  const updateTranscript = (content: string, appendMessage = false): void => {
    const current = detailState();
    const messages = appendMessage
      ? [
          ...current.messages,
          transcriptMessage(
            `assistant-${String(current.messages.length)}`,
            content,
            "assistant",
            current.messages.length + 2,
          ),
        ]
      : current.messages.map((message, index) =>
          index === current.messages.length - 1
            ? { ...message, content }
            : message,
        );
    transitionTo({ ...current, messages });
  };
  let detailState = (): AgentSessionDetail => detail;
  const transitionTo = (next: AgentSessionDetail): void => {
    detailState = () => next;
    replacement.replace(next);
  };
  const transcript = queryTestTranscript(mounted.container);
  const toggle = mounted.container.querySelector<HTMLButtonElement>(
    "[data-scroll-lock-toggle='true']",
  );
  if (toggle === null) {
    throw new TypeError("Missing scroll test controls");
  }
  let scrollHeight = 500;
  defineElementSize(transcript, 100, () => scrollHeight);
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
    growBeforePaint: (height: number) => {
      scrollHeight = height;
    },
    notifyScroll: () => {
      transcript.dispatchEvent(new Event("scroll"));
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
    transitionTo,
  };
}

function exerciseScrollGrowth(
  view: ReturnType<typeof scrollingTranscript>,
  content: string,
  height: number,
): void {
  view.stream(content);
  view.paintAfterLayout(height);
}

test("stays locked to the bottom while assistant content streams", () => {
  const view = scrollingTranscript();
  view.scrollTo(360);
  exerciseScrollGrowth(view, "Live output grows", 650);
  view.expectTop(650);

  exerciseScrollGrowth(view, "Live output grows again", 800);
  view.expectTop(800);
  view.expectLocked(true);
});

test("stays locked when a delayed scroll event observes newer streamed layout", () => {
  const view = scrollingTranscript();
  view.scrollTo(400);
  view.stream("First streamed frame");
  view.paintAfterLayout(650);

  view.stream("A larger second streamed frame");
  view.growBeforePaint(900);
  view.notifyScroll();

  view.expectLocked(true);
  view.paintAfterLayout(900);
  view.expectTop(900);
});

test("scrolling up releases the lock before a queued scroll can snap back", () => {
  const view = scrollingTranscript();
  view.scrollTo(400);
  exerciseScrollGrowth(view, "A completed update", 650);
  view.stream("A queued update");
  view.expectFrames(1);

  view.scrollTo(200);
  view.paintAfterLayout(800);
  view.expectTop(200);
  view.expectLocked(false);

  view.stream("More output while reading above");
  view.expectFrames(0);
  view.expectTop(200);
});

test("scrolling back to the bottom restores streaming scroll lock", () => {
  const view = scrollingTranscript();
  unlockScrollTestView(view);
  view.stream("Output ignored while unlocked");
  view.expectFrames(0);

  view.scrollTo(400);
  view.expectLocked(true);
  view.stream("Output followed after relocking");
  view.paintAfterLayout(700);
  view.expectTop(700);
});

test("an in-place session transition resets an unlocked transcript at its end", () => {
  const view = scrollingTranscript();
  unlockScrollTestView(view);

  view.transitionTo({
    ...TEST_SESSION_DETAIL,
    id: "created-or-forked-session",
    messages: [
      transcriptMessage("new-user", "Created session task", "user", 4),
      transcriptMessage("new-agent", "Created response", "assistant", 5),
    ],
    title: "Created or forked session",
    updatedAt: 5,
  });

  view.expectLocked(true);
  expectScrollTestPaint(view, 900);

  view.stream("Later growth in the replacement session");
  view.paintAfterLayout(1_000);
  view.expectTop(1_000);
});

test("scroll lock waits for transcript layout before using its new height", () => {
  const view = scrollingTranscript();
  view.stream("A newly rendered message", true);

  view.expectTop(0);
  expectScrollTestPaint(view, 900);
});
