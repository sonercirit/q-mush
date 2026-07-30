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
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  disposeTestViews,
  mountTestView,
  queryTestElement,
} from "./dom-test-helpers.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { pendingInputFixture } from "./session-pending-fixtures.ts";

const disposals = new Array<() => void>();

afterEach(function disposeComposerViews() {
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

function mountedComposer(status: AgentSessionDetail["status"] = "running"): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
  readonly prompt: HTMLTextAreaElement;
} {
  const detail = { ...TEST_SESSION_DETAIL, status };
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
  const { controller, detail, prompt } = mountedComposer();

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

function pressComposerShortcut(
  prompt: HTMLTextAreaElement,
  options: { readonly metaKey?: boolean; readonly shiftKey?: boolean } = {},
): void {
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: options.metaKey !== true,
      key: "Enter",
      metaKey: options.metaKey ?? false,
      shiftKey: options.shiftKey ?? false,
    }),
  );
}

function composerButtons(container: ParentNode): readonly HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      "[data-session-composer-actions='true'] button",
    ),
  ];
}

function expectComposerButtonShortcuts(
  buttons: readonly HTMLButtonElement[],
  labels: readonly string[],
  keys: readonly string[],
): void {
  expect(buttons.map(({ textContent }) => textContent)).toEqual(labels);
  expect(
    buttons.map((button) => button.getAttribute("aria-keyshortcuts")),
  ).toEqual(keys);
}

test("shows Steer before Follow up with their shortcut hints", () => {
  const { container } = mountedComposer();
  const buttons = composerButtons(container);

  expectComposerButtonShortcuts(
    buttons,
    ["SteerCtrl+Enter", "Follow upCtrl+Shift+Enter"],
    ["Control+Enter", "Control+Shift+Enter"],
  );
});

test("the visible steer action flushes the draft and uses Ctrl+Enter", () => {
  const { container, controller, prompt } = mountedComposer();
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

  pressComposerShortcut(prompt);

  expect(steer).toHaveBeenCalledTimes(2);

  const followUp = vi.spyOn(controller, "followUp").mockResolvedValue();
  pressComposerShortcut(prompt, { shiftKey: true });

  expect(followUp).toHaveBeenCalledOnce();
  expect(steer).toHaveBeenCalledTimes(2);
});

test("Ctrl+Enter and Meta+Enter send from an idle composer", () => {
  const { container, controller, prompt } = mountedComposer("idle");
  const send = vi.spyOn(controller, "send").mockResolvedValue();
  const sendButton = queryTestElement(
    container,
    "[data-session-composer-actions='true'] button[type='submit']",
  );

  pressComposerShortcut(prompt);
  pressComposerShortcut(prompt, { metaKey: true });

  expect(send).toHaveBeenCalledTimes(2);
  expect(sendButton.textContent).toBe("SendCtrl+Enter");
  expect(sendButton.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
});

test("Ctrl/Cmd+Shift+Enter continues with the platform shortcut hint", () => {
  const platform = vi
    .spyOn(navigator, "platform", "get")
    .mockReturnValue("MacIntel");
  disposals.push(() => {
    platform.mockRestore();
  });
  const { container, controller, prompt } = mountedComposer("idle");
  const continueSession = vi
    .spyOn(controller, "continueSession")
    .mockResolvedValue();
  const buttons = composerButtons(container);

  pressComposerShortcut(prompt, { shiftKey: true });
  pressComposerShortcut(prompt, { metaKey: true, shiftKey: true });

  expect(continueSession).toHaveBeenCalledTimes(2);
  expectComposerButtonShortcuts(
    buttons,
    ["Send⌘+Enter", "Continue without message⌘+Shift+Enter"],
    ["Meta+Enter", "Meta+Shift+Enter"],
  );
  expect(buttons[1]?.title).toBe("Continue without message (⌘+Shift+Enter)");
});

test("pending instructions react to realtime detail updates", () => {
  const { container, controller, detail } = mountedComposer();
  const pendingSelector = "section[aria-label='Queued session inputs']";

  expect(container.querySelector(pendingSelector)).toBeNull();

  controller.applyDetail({
    ...detail,
    pendingInputs: [pendingInputFixture("New instruction")],
    updatedAt: detail.updatedAt + 1,
  });

  expect(container.querySelector(pendingSelector)?.textContent).toContain(
    "New instruction",
  );

  controller.applyDetail({
    ...detail,
    pendingInputs: [],
    updatedAt: detail.updatedAt + 2,
  });

  expect(container.querySelector(pendingSelector)).toBeNull();
});

test("cancel returns a pending instruction to the composer", async () => {
  const detail = {
    ...TEST_SESSION_DETAIL,
    pendingInputs: [
      pendingInputFixture("Edit this instruction", {
        id: "pending-1",
        images: [TEST_AGENT_IMAGE],
      }),
    ],
    status: "running" as const,
  };
  const calls: unknown[][] = [];
  const reactive = createReactiveState<SessionViewState>(
    Object.assign(initialSessionViewState(), {
      detail,
      selectedId: detail.id,
      sessions: [summaryFromDetail(detail)],
    }),
  );
  const cancellationCommand = (...parameters: readonly unknown[]) => {
    const [operation, payload, idempotencyKey] = parameters;
    calls.push([operation, payload, idempotencyKey]);
    return Promise.resolve(
      Object.fromEntries([
        ["detail", { ...detail, pendingInputs: [] }],
        ["input", detail.pendingInputs[0]],
      ]),
    );
  };
  const controller = new SessionController(reactive, undefined, null, {
    command: cancellationCommand,
  });

  await controller.cancelPendingInput("pending-1");

  expect(calls).toEqual([
    [
      "sessions.cancel_pending_input",
      { inputId: "pending-1", sessionId: detail.id },
      expect.any(String),
    ],
  ]);
  expect(controller.state).toMatchObject({
    followUp: "Edit this instruction",
    followUpImages: [TEST_AGENT_IMAGE],
  });
  expect(controller.state.detail?.pendingInputs).toEqual([]);
});

test("pending cancellation button invokes its callback", () => {
  const onCancel = vi.fn();
  const container = mountTestView(
    () => (
      <SessionPendingInputs
        inputs={[pendingInputFixture("Editable", { id: "pending-1" })]}
        onCancel={onCancel}
      />
    ),
    disposals,
  );

  const cancel = queryTestElement(
    container,
    "button[aria-label='Cancel queued follow up']",
  );
  if (!(cancel instanceof HTMLButtonElement)) {
    throw new TypeError("The pending cancel action is unavailable");
  }
  cancel.click();

  expect(onCancel).toHaveBeenCalledWith("pending-1");
});

test("renders pending instructions in FIFO order", () => {
  const container = mountTestView(
    () => (
      <SessionPendingInputs
        inputs={[
          pendingInputFixture("First", { id: "pending-1" }),
          pendingInputFixture("Second", { id: "pending-2", kind: "steer" }),
        ]}
        onCancel={() => undefined}
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
    expect.stringMatching(/Queued follow up.*First/u),
    expect.stringMatching(/Queued steer.*Second/u),
  ]);
});

test("exposes platform-specific shortcuts", () => {
  expect(platformSessionShortcuts("Linux x86_64")).toEqual({
    followUpKeys: "Control+Shift+Enter",
    followUpLabel: "Ctrl+Shift+Enter",
    steerKeys: "Control+Enter",
    steerLabel: "Ctrl+Enter",
  });
  expect(platformSessionShortcuts("MacIntel")).toEqual({
    followUpKeys: "Meta+Shift+Enter",
    followUpLabel: "⌘+Shift+Enter",
    steerKeys: "Meta+Enter",
    steerLabel: "⌘+Enter",
  });
});
