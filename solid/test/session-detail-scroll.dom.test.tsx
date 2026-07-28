import { createSignal, untrack } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionViewState } from "../session-client.tsx";
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

test("scroll lock waits for realtime transcript layout before scrolling", () => {
  const detail = {
    ...TEST_SESSION_DETAIL,
    messages: [transcriptMessage("user-frame", "Initial task", "user", 2)],
    status: "running" as const,
  };
  const reactive = sessionDetailState(detail, [summaryFromDetail(detail)]);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const mounted = mountSessionDetailBody(
    reactive,
    DOM_TEST_DISPOSALS,
    undefined,
    (props) => {
      const [view, setView] = createSignal<LoadedSessionDetailViewProps>(
        untrack(() => props.view),
      );
      const nextDetail = {
        ...detail,
        messages: [
          ...detail.messages,
          transcriptMessage("assistant-frame", "Live output", "assistant", 3),
        ],
      };
      const update = (): void => {
        const nextState: SessionViewState = {
          ...reactive.state(),
          detail: nextDetail,
        };
        setView((current) => ({
          ...current,
          detail: nextDetail,
          state: nextState,
        }));
      };
      return (
        <>
          <button
            data-update-transcript="true"
            onClick={update}
            type="button"
          />
          <SessionDetailBody {...props} view={view()} />
        </>
      );
    },
  );
  const transcript = queryTestTranscript(mounted.container);
  let scrollHeight = 500;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  frames.length = 0;

  mounted.container
    .querySelector<HTMLButtonElement>("[data-update-transcript='true']")
    ?.click();

  expect(transcript.scrollTop).toBe(0);
  expect(frames).toHaveLength(1);

  scrollHeight = 900;
  frames.shift()?.(0);

  expect(transcript.scrollTop).toBe(900);
});
