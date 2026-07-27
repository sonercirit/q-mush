import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { sessionComposerUnavailableReason } from "../session-composer-availability.ts";
import { SessionController } from "../session-controller.ts";
import {
  platformSessionShortcuts,
  SessionPendingInputs,
} from "../session-pending-client.tsx";
import {
  pendingInputOperation,
  requestPendingInput,
  samePendingInputAttempt,
  sessionCanQueuePendingInput,
} from "../session-pending-input.ts";
import { initialSessionViewState } from "../session-state.ts";
import {
  disposeTestViews,
  mountTestView,
  queryTestElement,
} from "./dom-test-helpers.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { pendingInputFixture } from "./session-pending-fixtures.ts";

const disposals: (() => void)[] = [];

afterEach(() => {
  disposeTestViews(disposals);
});

test("active composer availability permits durable pending inputs", () => {
  for (const status of ["queued", "running"] as const) {
    expect(
      sessionComposerUnavailableReason(
        { ...TEST_SESSION_DETAIL, status },
        initialSessionViewState(),
        true,
        true,
      ),
    ).toBeUndefined();
  }
  expect(
    sessionComposerUnavailableReason(
      { ...TEST_SESSION_DETAIL, status: "paused" },
      initialSessionViewState(),
      true,
      true,
    ),
  ).toBe("Session is paused for a safe restart handoff.");
});

test("pending input capabilities distinguish follow-up and steering", () => {
  expect(sessionCanQueuePendingInput("queued", "follow_up")).toBe(true);
  expect(sessionCanQueuePendingInput("queued", "steer")).toBe(false);
  expect(sessionCanQueuePendingInput("running", "follow_up")).toBe(true);
  expect(sessionCanQueuePendingInput("running", "steer")).toBe(true);
  expect(pendingInputOperation("follow_up")).toBe("sessions.follow_up");
  expect(pendingInputOperation("steer")).toBe("sessions.steer");
});

test("reuses only an exactly matching durable request attempt", () => {
  const attempt = {
    clientRequestId: "request-1",
    images: [],
    kind: "follow_up" as const,
    prompt: "Continue",
    sessionId: "session-1",
  };
  expect(
    samePendingInputAttempt(attempt, {
      images: [],
      kind: "follow_up",
      prompt: "Continue",
      sessionId: "session-1",
    }),
  ).toBe(true);
  expect(
    samePendingInputAttempt(attempt, {
      images: [],
      kind: "steer",
      prompt: "Continue",
      sessionId: "session-1",
    }),
  ).toBe(false);
});

function acceptedPendingInputTransport(calls: unknown[][]) {
  return {
    command: (
      operation: string,
      payload: Readonly<Record<string, unknown>>,
      idempotencyKey: string,
    ) => {
      calls.push([operation, payload, idempotencyKey]);
      return Promise.resolve({ status: "accepted" as const });
    },
  };
}

test("sends pending input through authenticated realtime commands", async () => {
  const calls: unknown[][] = [];
  const result = requestPendingInput(acceptedPendingInputTransport(calls), {
    clientRequestId: "request-1",
    images: [],
    kind: "steer",
    prompt: "Change direction",
    sessionId: "session-1",
  });

  await expect(result).resolves.toEqual({ status: "accepted" });
  expect(calls).toEqual([
    [
      "sessions.steer",
      {
        clientRequestId: "request-1",
        kind: "steer",
        prompt: "Change direction",
        sessionId: "session-1",
      },
      "request-1",
    ],
  ]);
});

test("reuses request identity after an unknown browser outcome", async () => {
  const running = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const state: SessionViewState = {
    ...initialSessionViewState(),
    detail: running,
    followUp: "Retry this",
    selectedId: running.id,
    sessions: [summaryFromDetail(running)],
  };
  const calls: unknown[][] = [];
  const controller = new SessionController(
    createReactiveState(state),
    undefined,
    null,
    {
      command: (_operation, payload, idempotencyKey) => {
        calls.push([payload, idempotencyKey]);
        if (calls.length === 1) {
          return Promise.reject(new Error("outcome_unknown"));
        }
        return Promise.resolve({
          ...running,
          pendingInputs: [
            pendingInputFixture(String(payload["prompt"]), {
              clientRequestId: String(payload["clientRequestId"]),
              id: "pending-1",
            }),
          ],
        });
      },
    },
  );

  await controller.followUp();
  await controller.followUp();

  expect(calls).toHaveLength(2);
  expect(calls[0]?.[0]).toMatchObject({
    clientRequestId: calls[0]?.[1],
    prompt: "Retry this",
  });
  expect(calls[1]).toEqual(calls[0]);
  expect(controller.state).toMatchObject({ followUp: "", sending: false });
  expect(controller.state.detail?.pendingInputs).toHaveLength(1);
});

function mountedRunningComposer(): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
  readonly prompt: HTMLTextAreaElement;
} {
  const detail = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const { container, controller } = mountTestSessionDetail(detail, disposals);
  const prompt = queryTestElement(
    container,
    "[data-session-composer='true'] textarea[name='prompt']",
  );
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("The running follow-up prompt is unavailable");
  }
  return { container, controller, detail, prompt };
}

test("follow-up typing updates locally before the shared session view", () => {
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  disposals.push(vi.useRealTimers);
  const { controller, detail, prompt } = mountedRunningComposer();

  prompt.value = "Change direction immediately";
  prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
  controller.applyDetail({
    ...detail,
    updatedAt: detail.updatedAt + 1,
  });

  expect(prompt.value).toBe("Change direction immediately");
  expect(controller.state.followUp).toBe("");

  vi.runAllTimers();

  expect(controller.state.followUp).toBe("Change direction immediately");
});

test("the visible steer action flushes the draft and keeps its shortcut", () => {
  const { container, controller, prompt } = mountedRunningComposer();
  const steer = vi.spyOn(controller, "steer").mockResolvedValue();
  const steerButton = queryTestElement(
    container,
    "[data-session-steer='true']",
  );
  if (!(steerButton instanceof HTMLButtonElement)) {
    throw new TypeError("The visible steer action is unavailable");
  }

  prompt.value = "Use a smaller change";
  prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
  steerButton.click();

  expect(steer).toHaveBeenCalledOnce();
  expect(controller.state.followUp).toBe("Use a smaller change");

  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "Enter",
      shiftKey: true,
    }),
  );

  expect(steer).toHaveBeenCalledTimes(2);
});

test("renders pending instructions in FIFO order", () => {
  const container = mountTestView(
    () => (
      <SessionPendingInputs
        inputs={[
          pendingInputFixture("First", { id: "pending-1" }),
          pendingInputFixture("Second", { id: "pending-2", kind: "steer" }),
        ]}
      />
    ),
    disposals,
  );

  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(
    "Queued session inputs",
  );
  expect(
    [...container.querySelectorAll("li")].map(({ textContent }) => textContent),
  ).toEqual([
    expect.stringContaining("Queued follow upFirst"),
    expect.stringContaining("Queued steerSecond"),
  ]);
});

test("exposes platform-specific shortcuts", () => {
  expect(platformSessionShortcuts("Linux x86_64")).toEqual({
    followUpKeys: "Control+Enter",
    followUpLabel: "Ctrl+Enter",
    steerKeys: "Control+Shift+Enter",
    steerLabel: "Ctrl+Shift+Enter",
  });
  expect(platformSessionShortcuts("MacIntel")).toEqual({
    followUpKeys: "Meta+Enter",
    followUpLabel: "⌘+Enter",
    steerKeys: "Meta+Shift+Enter",
    steerLabel: "⌘+Shift+Enter",
  });
});
