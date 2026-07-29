import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AgentSessionMessage,
  AgentSessionTurn,
} from "../../shared/session-model.ts";
import { sessionTurnTiming } from "../../shared/session-turn-timing.ts";
import { createDisplaySessionMessage } from "../session-message.ts";
import { disposeTestViews } from "./dom-test-helpers.ts";
import {
  mountTestTranscriptView,
  transcriptTestMessage,
} from "./session-dom-test-helpers.tsx";

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

function expectCompletedTiming(
  actual: ReturnType<typeof sessionTurnTiming>,
  expected: readonly (readonly [string, object])[],
): void {
  expect([...actual.completedTimings]).toEqual(expected);
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

  const timings = sessionTurnTiming(
    messages,
    "idle",
    undefined,
  ).completedTimings;

  expect([...timings]).toEqual([
    ["timing-message-100", { endedAt: null, startedAt: 0 }],
  ]);
  expect(roleReads).toBeLessThan(messages.length * 4);
});

test("does not complete the active final turn", () => {
  const messages = [timingMessage("user", 1), timingMessage("assistant", 2)];

  expect(
    sessionTurnTiming(messages, "running", undefined).completedTimings.size,
  ).toBe(0);
  expect([
    ...sessionTurnTiming(messages, "idle", undefined).completedTimings,
  ]).toEqual([["timing-message-2", { endedAt: null, startedAt: 1 }]]);
});

test("completes a final user-only turn when the session is idle", () => {
  const message = timingMessage("user", 1);

  expect([
    ...sessionTurnTiming([message], "idle", undefined).completedTimings,
  ]).toEqual([[message.id, { endedAt: null, startedAt: message.createdAt }]]);
  expect(
    sessionTurnTiming([message], "running", undefined).completedTimings.size,
  ).toBe(0);
});

test("keeps completed and user-less continuation turns distinct", () => {
  const firstUser = { ...timingMessage("user", 1), turnId: "turn-0" };
  const firstAssistant = {
    ...timingMessage("assistant", 2),
    turnId: "turn-0",
  };
  const continuation = {
    ...timingMessage("assistant", 101),
    turnId: "turn-1",
  };
  const turns: readonly AgentSessionTurn[] = [
    {
      boundaryMessageId: firstAssistant.id,
      endedAt: 3,
      executionGeneration: 0,
      id: "turn-0",
      startedAt: 1,
    },
    {
      boundaryMessageId: null,
      endedAt: null,
      executionGeneration: 1,
      id: "turn-1",
      startedAt: 100,
    },
  ];

  const active = sessionTurnTiming(
    [firstUser, firstAssistant],
    "running",
    turns,
  );
  expectCompletedTiming(active, [
    [firstAssistant.id, { endedAt: 3, startedAt: 1 }],
  ]);
  expect(active.activeStartedAt).toBe(100);

  const firstTurn = turns[0];
  const continuationTurn = turns[1];
  if (firstTurn === undefined || continuationTurn === undefined) {
    throw new Error("Missing test turns");
  }
  const completed = sessionTurnTiming(
    [firstUser, firstAssistant, continuation],
    "idle",
    [
      firstTurn,
      {
        ...continuationTurn,
        boundaryMessageId: continuation.id,
        endedAt: 103,
      },
    ],
  );
  expectCompletedTiming(completed, [
    [firstAssistant.id, { endedAt: 3, startedAt: 1 }],
    [continuation.id, { endedAt: 103, startedAt: 100 }],
  ]);
  expect(completed.activeStartedAt).toBeUndefined();
});

const disposals: (() => void)[] = [];

function turnTiming(container: ParentNode): Element | null {
  return container.querySelector("[data-turn-timing]");
}

function activeTranscript(startedAt: number, id: string) {
  return mountTestTranscriptView({
    messages: () => [transcriptTestMessage(id, "Active", "user", startedAt)],
    status: () => "running",
  });
}

afterEach(() => {
  disposeTestViews(disposals);
  vi.useRealTimers();
});

test("active clocks share one interval and release it after the final dispose", () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 6, 27, 11, 0, 0) });
  const startedAt = Date.now();
  const setInterval = vi.spyOn(window, "setInterval");
  const clearInterval = vi.spyOn(window, "clearInterval");

  const first = activeTranscript(startedAt, "first-active");
  const second = activeTranscript(startedAt, "second-active");

  expect(setInterval).toHaveBeenCalledTimes(1);
  first.dispose();
  expect(clearInterval).not.toHaveBeenCalled();
  second.dispose();
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
  const clearInterval = vi.spyOn(window, "clearInterval");
  const view = mountTestTranscriptView({
    messages,
    status: () => (messages().length === 1 ? "running" : "idle"),
  });
  const { container } = view;
  disposals.push(view.dispose);
  const timingText = (): string | null | undefined =>
    turnTiming(container)?.textContent;
  const expectDuration = (seconds: number): void => {
    expect(timingText()).toContain(`Duration: ${String(seconds)}s`);
  };

  expect(turnTiming(container)?.getAttribute("data-turn-timing")).toBe(
    "active",
  );
  expect(turnTiming(container)?.querySelector("time")?.dateTime).toBe(
    new Date(startedAt).toISOString(),
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

  const unmounted = mountTestTranscriptView({
    messages: () => [
      transcriptTestMessage("user-unmount", "Unmount", "user", startedAt),
    ],
    status: () => "running",
  });
  unmounted.dispose();
  expect(clearInterval).toHaveBeenCalledTimes(1);
  clearInterval.mockRestore();
});
