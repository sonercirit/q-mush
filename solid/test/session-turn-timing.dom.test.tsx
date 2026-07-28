import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AgentSessionMessage,
  AgentSessionStatus,
} from "../../shared/session-model.ts";
import { sessionTurnStartedAtByMessage } from "../../shared/session-turn-timing.ts";
import { createDisplaySessionMessage } from "../session-message.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../session-transcript-filters.ts";
import { SessionTranscript } from "../session-transcript.tsx";
import { disposeTestViews } from "./dom-test-helpers.ts";
import { transcriptTestMessage } from "./session-dom-test-helpers.tsx";

function timingMessage(
  role: AgentSessionMessage["role"],
  index: number,
): AgentSessionMessage {
  return createDisplaySessionMessage({
    content: role,
    createdAt: index,
    id: `timing-message-${String(index)}`,
    role,
  });
}

test("derives completed turn timings in one transcript traversal", () => {
  let roleReads = 0;
  const messages = [
    timingMessage("user", 0),
    ...Array.from({ length: 100 }, (_, index) =>
      timingMessage("assistant", index + 1),
    ),
  ];
  for (const current of messages) {
    const role = current.role;
    Object.defineProperty(current, "role", {
      get: () => {
        roleReads += 1;
        return role;
      },
    });
  }

  const starts = sessionTurnStartedAtByMessage(messages, "idle");

  expect([...starts]).toEqual([["timing-message-100", 0]]);
  expect(roleReads).toBeLessThan(messages.length * 4);
});

test("does not complete the active final turn", () => {
  const messages = [timingMessage("user", 1), timingMessage("assistant", 2)];

  expect(sessionTurnStartedAtByMessage(messages, "running").size).toBe(0);
  expect([...sessionTurnStartedAtByMessage(messages, "idle")]).toEqual([
    ["timing-message-2", 1],
  ]);
});

const disposals: (() => void)[] = [];

function renderTranscriptView(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
): JSX.Element {
  return (
    <SessionTranscript
      agentFile={null}
      executionEnvironment="bare_metal"
      filters={DEFAULT_SESSION_TRANSCRIPT_FILTERS}
      messages={messages}
      status={status}
      tools={[]}
    />
  );
}

function turnTiming(container: ParentNode): Element | null {
  return container.querySelector("[data-turn-timing]");
}

function activeTranscript(startedAt: number, id: string): JSX.Element {
  return renderTranscriptView(
    [transcriptTestMessage(id, "Active", "user", startedAt)],
    "running",
  );
}

afterEach(() => {
  disposeTestViews(disposals);
  vi.useRealTimers();
});

test("active clocks share one interval and release it after the final dispose", () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 6, 27, 11, 0, 0) });
  const startedAt = Date.now();
  const first = document.createElement("ul");
  const second = document.createElement("ul");
  document.body.append(first, second);
  const setInterval = vi.spyOn(window, "setInterval");
  const clearInterval = vi.spyOn(window, "clearInterval");

  const disposeFirst = render(
    () => activeTranscript(startedAt, "first-active"),
    first,
  );
  const disposeSecond = render(
    () => activeTranscript(startedAt, "second-active"),
    second,
  );

  expect(setInterval).toHaveBeenCalledTimes(1);
  disposeFirst();
  expect(clearInterval).not.toHaveBeenCalled();
  disposeSecond();
  expect(clearInterval).toHaveBeenCalledTimes(1);
  setInterval.mockRestore();
  clearInterval.mockRestore();
});

test("active turn timer updates live, stops on completion, and is cleaned up", () => {
  vi.useFakeTimers();
  const startedAt = Date.UTC(2026, 6, 27, 12, 0, 0);
  vi.setSystemTime(startedAt);
  const [messages, setMessages] = createSignal<readonly AgentSessionMessage[]>([
    transcriptTestMessage("user-active", "Active request", "user", startedAt),
  ]);
  const container = document.createElement("ul");
  document.body.append(container);
  const clearInterval = vi.spyOn(window, "clearInterval");
  const renderTranscript = (
    transcriptContainer: HTMLElement,
    transcriptMessages: () => readonly AgentSessionMessage[],
    transcriptStatus: () => AgentSessionStatus,
  ): ReturnType<typeof render> => {
    const view = (): JSX.Element =>
      renderTranscriptView(transcriptMessages(), transcriptStatus());
    return render(view, transcriptContainer);
  };
  const activeView = (): JSX.Element => {
    const currentMessages = messages();
    return renderTranscriptView(
      currentMessages,
      currentMessages.length === 1 ? "running" : "idle",
    );
  };
  const dispose = render(() => <>{activeView()}</>, container);
  disposals.push(dispose);
  const timingText = (): string | null | undefined =>
    turnTiming(container)?.textContent;
  const expectDuration = (seconds: number): void => {
    expect(timingText()).toContain(`Duration: ${String(seconds)}s`);
  };

  expect(turnTiming(container)?.getAttribute("data-turn-timing")).toBe(
    "active",
  );
  expectDuration(0);
  vi.advanceTimersByTime(2_000);
  expectDuration(2);

  const endedAt = startedAt + 2_000;
  setMessages((currentMessages) => [
    ...currentMessages,
    transcriptTestMessage(
      "assistant-active",
      "Completed response",
      "assistant",
      endedAt,
    ),
  ]);

  expect(turnTiming(container)?.getAttribute("data-turn-timing")).toBe(
    "completed",
  );
  expectDuration(2);
  expect(clearInterval).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2_000);
  expectDuration(2);

  clearInterval.mockClear();
  disposals.pop()?.();
  expect(clearInterval).not.toHaveBeenCalled();

  const unmountContainer = document.createElement("ul");
  document.body.append(unmountContainer);
  const disposeUnmounted = renderTranscript(
    unmountContainer,
    () => [transcriptTestMessage("user-unmount", "Unmount", "user", startedAt)],
    () => "running",
  );
  disposeUnmounted();
  expect(clearInterval).toHaveBeenCalledTimes(1);
  clearInterval.mockRestore();
});
