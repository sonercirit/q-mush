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
  sessionCanQueuePendingInput,
} from "../session-pending-input.ts";
import { initialSessionViewState } from "../session-state.ts";
import type { SessionCommandTransport } from "../session-transport.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  disposeTestViews,
  mountTestView,
  queryTestElement,
} from "./dom-test-helpers.ts";
import {
  mountSessionDetailBody,
  mountTestSessionDetail,
} from "./session-dom-test-helpers.tsx";
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

function testPendingInputState(
  prompt: string,
  command: SessionCommandTransport["command"],
) {
  const detail = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail,
    followUp: prompt,
    selectedId: detail.id,
    sessions: [summaryFromDetail(detail)],
  });
  return {
    detail,
    ...mountSessionDetailBody(reactive, disposals, { command }),
  };
}

test("optimistically shows pending input before the realtime command settles", async () => {
  let resolveCommand: ((value: unknown) => void) | undefined;
  const completion = new Promise<unknown>((resolve) => {
    resolveCommand = resolve;
  });
  const {
    container,
    controller,
    detail: running,
  } = testPendingInputState("Visible immediately", () => completion);

  const submitted = controller.followUp();

  expect(container.textContent).toContain("Visible immediately");
  expect(container.textContent).toContain("Sending…");
  const optimistic = controller.state.optimisticPendingInputs[0];
  if (optimistic === undefined || resolveCommand === undefined) {
    throw new TypeError("Expected an optimistic pending input");
  }
  expect(controller.state.optimisticPendingInputs).toMatchObject([
    {
      content: "Visible immediately",
      status: "sending",
    },
  ]);
  expect(optimistic.clientRequestId).not.toBe("");
  resolveCommand({
    ...running,
    pendingInputs: [
      pendingInputFixture(optimistic.content, {
        clientRequestId: optimistic.clientRequestId,
        createdAt: optimistic.createdAt + 1,
        id: "pending-authoritative",
      }),
    ],
    updatedAt: running.updatedAt + 1,
  });
  await submitted;

  expect(controller.state.detail?.pendingInputs.map(({ id }) => id)).toContain(
    "pending-authoritative",
  );
  expect(container.textContent).not.toContain("Sending…");
  expect(controller.state.optimisticPendingInputs).toEqual([]);
});

test("rolls an optimistic pending input back into the composer on failure", async () => {
  const { container, controller } = testPendingInputState(
    "Do not lose this",
    () => Promise.reject(new Error("request_failed")),
  );

  await controller.followUp();

  expect(controller.state).toMatchObject({
    followUp: "Do not lose this",
    optimisticPendingInputs: [],
    sending: false,
  });
  const prompt = queryTestElement(container, "textarea[name='prompt']");
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("Expected the follow-up textarea");
  }
  expect(prompt.value).toBe("Do not lose this");
  expect(controller.state.error).toContain("could not queue that follow-up");
});
test("retries the clicked unconfirmed payload with its original identity", async () => {
  const running = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const state: SessionViewState = {
    ...initialSessionViewState(),
    detail: running,
    followUp: "Retry this exact payload",
    followUpImages: [TEST_AGENT_IMAGE],
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
        if (calls.length < 3) {
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
  const firstRequestId =
    controller.state.optimisticPendingInputs[0]?.clientRequestId;
  if (firstRequestId === undefined) {
    throw new TypeError("Expected the first unconfirmed attempt");
  }
  controller.setFollowUp("A genuinely new send");
  controller.removeImage(0, "followUp");
  await controller.followUp();
  const secondRequestId =
    controller.state.optimisticPendingInputs[1]?.clientRequestId;
  controller.setFollowUp("Keep this edited draft");

  await controller.retryPendingInput(firstRequestId);

  expect(secondRequestId).toEqual(expect.any(String));
  expect(secondRequestId).not.toBe(firstRequestId);
  expect(calls).toHaveLength(3);
  expect(calls[2]).toEqual(calls[0]);
  expect(calls[2]).not.toEqual(calls[1]);
  expect(calls[2]?.[0]).toMatchObject({
    clientRequestId: firstRequestId,
    images: [TEST_AGENT_IMAGE],
    prompt: "Retry this exact payload",
  });
  expect(controller.state).toMatchObject({
    followUp: "Keep this edited draft",
    sending: false,
  });
  expect(controller.state.optimisticPendingInputs).toMatchObject([
    { clientRequestId: secondRequestId, status: "unconfirmed" },
  ]);
});

test("bounds an unacknowledged pending-input send as unconfirmed", async () => {
  vi.useFakeTimers();
  disposals.push(vi.useRealTimers);
  const { container, controller } = testPendingInputState(
    "Do not wait forever",
    () => new Promise(() => undefined),
  );

  const submitted = controller.followUp();
  await vi.advanceTimersByTimeAsync(60_000);
  await submitted;

  expect(controller.state).toMatchObject({
    followUp: "Do not wait forever",
    sending: false,
  });
  expect(controller.state.optimisticPendingInputs[0]?.status).toBe(
    "unconfirmed",
  );
  expect(container.textContent).toContain("Delivery unconfirmed");
});

test("authoritative echo settles a send and cancels its confirmation timer", async () => {
  let confirmation: (() => void) | undefined;
  let timeoutSequence = 0;
  const timers = new Map<number, () => void>();
  const detail = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const state: SessionViewState = {
    ...initialSessionViewState(),
    detail,
    followUp: "Confirm from the echo",
    selectedId: detail.id,
    sessions: [summaryFromDetail(detail)],
  };
  const controller = new SessionController(
    createReactiveState(state),
    undefined,
    null,
    {
      command: () =>
        new Promise((resolve) => {
          confirmation = () => {
            resolve(undefined);
          };
        }),
    },
    {
      clearTimeout: (timeout) => {
        timers.delete(timeout);
      },
      setTimeout: (callback) => {
        timeoutSequence += 1;
        timers.set(timeoutSequence, callback);
        return timeoutSequence;
      },
    },
  );

  const submitted = controller.followUp();
  const optimistic = controller.state.optimisticPendingInputs[0];
  if (optimistic === undefined) {
    throw new TypeError("Expected an optimistic pending input");
  }
  expect(timers).toHaveLength(1);
  controller.applyDetail({
    ...detail,
    pendingInputs: [
      pendingInputFixture(optimistic.content, {
        clientRequestId: optimistic.clientRequestId,
        id: "pending-echo",
      }),
    ],
    updatedAt: detail.updatedAt + 1,
  });

  await submitted;

  expect(timers).toHaveLength(0);
  expect(controller.state).toMatchObject({
    optimisticPendingInputs: [],
    sending: false,
  });
  confirmation?.();
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
        onRetry={() => undefined}
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
        onRetry={() => undefined}
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
