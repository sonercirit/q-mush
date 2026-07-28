import { expect, test, vi } from "vitest";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../session-transcript-filters.ts";
import { SessionTranscript } from "../session-transcript.tsx";
import { mountTestView } from "./dom-test-helpers.ts";
import { transcriptTestMessage } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const ForkDetail = SessionDetail;

function forkDisposals(): (() => void)[] {
  return [];
}

function disposeForkTest(disposals: readonly (() => void)[]): void {
  for (const dispose of disposals) {
    dispose();
  }
}

test("fork transcript controls report the selected message", () => {
  const disposals = forkDisposals();
  const onFork = vi.fn();
  const container = mountTestView(
    () => (
      <ul>
        <SessionTranscript
          agentFile={null}
          executionEnvironment="bare_metal"
          filters={DEFAULT_SESSION_TRANSCRIPT_FILTERS}
          messages={[
            transcriptTestMessage("user-1", "Request", "user", 1),
            transcriptTestMessage("assistant-1", "Response", "assistant", 2),
          ]}
          onFork={onFork}
          tools={[]}
        />
      </ul>
    ),
    disposals,
  );

  const button = container.querySelector<HTMLButtonElement>(
    '[data-fork-from-here="assistant-1"]',
  );
  button?.click();

  expect(button?.textContent).toContain("Fork from here");
  expect(onFork).toHaveBeenCalledWith("assistant-1");
  disposeForkTest(disposals);
});

test("historical transcript pages do not offer fork controls", () => {
  const onFork = vi.fn();
  const disposals = forkDisposals();
  disposals.push(() => onFork.mockClear());
  const current = transcriptTestMessage("current-1", "Current", "user", 2);
  const historical = transcriptTestMessage(
    "historical-1",
    "Historical",
    "user",
    1,
  );
  const detail = { ...TEST_SESSION_DETAIL, messages: [current] };
  const initial = initialSessionViewState();
  const reactive = createReactiveState<SessionViewState>({
    ...initial,
    detail,
    history: {
      canGoOlder: false,
      error: undefined,
      loading: false,
      page: {
        currentSegment: 1,
        messages: [historical],
        newerCursor: null,
        olderCursor: null,
        segment: 0,
        sessionId: detail.id,
      },
    },
    selectedId: detail.id,
    sessions: [summaryFromDetail(detail)],
  });
  const controller = new SessionController(reactive, undefined, null);
  vi.spyOn(controller, "fork").mockImplementation((messageId) => {
    onFork(messageId);
    return Promise.resolve();
  });
  const container = mountTestView(
    () =>
      ForkDetail({
        controller,
        credentialAvailable: true,
        credentials: [],
        onOpenDirectoryPicker: vi.fn(),
        runners: [],
        state: reactive.state(),
      }),
    disposals,
  );

  container
    .querySelector<HTMLButtonElement>('[data-fork-from-here="historical-1"]')
    ?.click();

  expect(container.textContent).toContain("Historical");
  expect(container.textContent).not.toContain("Current");
  expect(container.querySelector("[data-fork-from-here]")).toBeNull();
  expect(onFork).not.toHaveBeenCalled();
  disposeForkTest(disposals);
});
