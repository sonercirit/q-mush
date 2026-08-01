import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { sessionStepTiming } from "../../shared/session-step-timing.ts";
import { startedAtUtc } from "../../shared/test/session-fixtures.ts";
import { disposeTestViews } from "./dom-test-helpers.ts";
import {
  mountTestTranscriptView,
  transcriptTestMessage,
} from "./session-dom-test-helpers.tsx";

function message(
  id: string,
  role: AgentSessionMessage["role"],
  createdAt: number,
): AgentSessionMessage {
  return transcriptTestMessage(id, role, role, createdAt);
}

function assistantCall(
  id: string,
  createdAt: number,
  toolCallIds: readonly string[],
): AgentSessionMessage {
  return {
    ...message(id, "assistant", createdAt),
    toolCalls: toolCallIds.map((callId) => ({
      arguments: "{}",
      id: callId,
      name: "read",
    })),
  };
}

function toolResult(
  id: string,
  createdAt: number,
  callId: string,
): AgentSessionMessage {
  return {
    ...message(id, "tool", createdAt),
    toolCallId: callId,
    toolName: "read",
  };
}

function expectCompletedTiming(
  actual: ReturnType<typeof sessionStepTiming>,
  expected: readonly (readonly [string, object])[],
): void {
  expect([...actual.completedTimings]).toEqual(expected);
}

test("derives multi-step boundaries in one transcript traversal", () => {
  let roleReads = 0;
  const messages = [
    message("user", "user", 1),
    assistantCall("call-one", 3, ["tool-one", "tool-two"]),
    toolResult("result-one", 5, "tool-one"),
    toolResult("result-two", 8, "tool-two"),
    message("thinking-two", "thinking", 10),
    message("assistant-two", "assistant", 13),
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

  const timing = sessionStepTiming(messages, "idle", undefined);

  expectCompletedTiming(timing, [
    ["result-two", { endedAt: 8, startedAt: 1 }],
    ["assistant-two", { endedAt: 13, startedAt: 8 }],
  ]);
  expect(timing.activeStartedAt).toBeUndefined();
  expect(roleReads).toBeLessThan(messages.length * 4);
});

test("derives a single-step turn from user to terminal assistant", () => {
  expectCompletedTiming(
    sessionStepTiming(
      [message("user", "user", 1), message("assistant", "assistant", 4)],
      "idle",
      undefined,
    ),
    [["assistant", { endedAt: 4, startedAt: 1 }]],
  );
});

test("ignores transcript records outside model-call steps", () => {
  const timing = sessionStepTiming(
    [
      message("notice", "system", 1),
      message("error", "error", 2),
      toolResult("orphan-tool", 3, "missing-call"),
    ],
    "idle",
    undefined,
  );

  expect(timing.completedTimings.size).toBe(0);
  expect(timing.activeStartedAt).toBeUndefined();
});

test("uses durable turn settlement for a terminal step", () => {
  const user = { ...message("user", "user", 2), turnId: "turn-one" };
  const assistant = {
    ...message("assistant", "assistant", 5),
    turnId: "turn-one",
  };

  const timing = sessionStepTiming([user, assistant], "idle", [
    {
      boundaryMessageId: assistant.id,
      endedAt: 7,
      executionGeneration: 0,
      id: "turn-one",
      startedAt: 1,
    },
  ]);

  expectCompletedTiming(timing, [[assistant.id, { endedAt: 7, startedAt: 1 }]]);
});

test("keeps the step after settled tools active while the next call runs", () => {
  const timing = sessionStepTiming(
    [
      message("user", "user", 1),
      assistantCall("assistant", 3, ["tool"]),
      toolResult("result", 5, "tool"),
      message("stream:session:thinking", "thinking", 6),
      message("stream:session:assistant", "assistant", 6),
    ],
    "running",
    undefined,
  );

  expectCompletedTiming(timing, [["result", { endedAt: 5, startedAt: 1 }]]);
  expect(timing.activeStartedAt).toBe(5);
});

const disposals: (() => void)[] = [];

function stepTiming(container: ParentNode): Element | null {
  return container.querySelector("[data-step-timing]");
}

function expectStepTiming(
  container: ParentNode,
  state: "active" | "completed",
  duration: string,
): void {
  expect(stepTiming(container)?.getAttribute("data-step-timing")).toBe(state);
  expect(stepTiming(container)?.textContent).toContain(duration);
}

function activeTranscript(startedAt: number, id: string) {
  return mountTestTranscriptView({
    messages: () => [message(id, "user", startedAt)],
    status: () => "running",
  });
}

afterEach(() => {
  disposeTestViews(disposals);
  vi.useRealTimers();
});

test("places every step duration after that step's settlement message", () => {
  const startedAt = startedAtUtc();
  const messages = [
    message("user", "user", startedAt),
    assistantCall("first-assistant", startedAt + 1_000, ["first-tool"]),
    toolResult("first-result", startedAt + 4_000, "first-tool"),
    message("second-thinking", "thinking", startedAt + 6_000),
    message("second-assistant", "assistant", startedAt + 9_000),
  ];
  const view = mountTestTranscriptView({
    messages: () => messages,
    status: () => "idle",
  });
  disposals.push(view.dispose);

  const timings = [
    ...view.container.querySelectorAll("[data-step-timing='completed']"),
  ];
  expect(timings.map(({ textContent }) => textContent)).toEqual([
    expect.stringContaining("Duration: 4s"),
    expect.stringContaining("Duration: 5s"),
  ]);
  for (const [messageId, timing] of [
    ["first-result", timings[0]],
    ["second-assistant", timings[1]],
  ] as const) {
    const settlement = view.container.querySelector(
      `[data-render-boundary='message:${messageId}']`,
    );
    expect(settlement).not.toBeNull();
    expect(timing).toBeDefined();
    if (settlement === null || timing === undefined) {
      throw new Error("Missing step transcript elements");
    }
    expect(
      settlement.compareDocumentPosition(timing) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  }
});

test("active clocks share one interval and release it after final dispose", () => {
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

test("active step timer updates live and stops on completion", () => {
  vi.useFakeTimers();
  const startedAt = Date.UTC(2026, 6, 27, 12, 0, 0);
  vi.setSystemTime(startedAt);
  const [messages, setMessages] = createSignal<readonly AgentSessionMessage[]>([
    message("user-active", "user", startedAt),
  ]);
  const clearInterval = vi.spyOn(window, "clearInterval");
  const view = mountTestTranscriptView({
    messages,
    status: () => (messages().length === 1 ? "running" : "idle"),
  });
  disposals.push(view.dispose);
  expectStepTiming(view.container, "active", "Duration: 0s");
  vi.advanceTimersByTime(2_000);
  expectStepTiming(view.container, "active", "Duration: 2s");

  setMessages((current) => [
    ...current,
    message("assistant-active", "assistant", startedAt + 2_000),
  ]);

  expectStepTiming(view.container, "completed", "Duration: 2s");
  expect(clearInterval).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2_000);
  expectStepTiming(view.container, "completed", "Duration: 2s");
  clearInterval.mockRestore();
});
