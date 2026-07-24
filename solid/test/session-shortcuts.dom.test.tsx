import { type JSX } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { createProviderViewState } from "../provider-client.tsx";
import { createReactiveState } from "../reactive-state.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { ShortcutProvider } from "../shortcut-client.tsx";
import { KeyboardShortcutRegistry } from "../shortcut-registry.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import {
  disposeTestViews,
  mountTestView,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { shortcutKeyEvent } from "./shortcut-test-helpers.ts";

const disposals: (() => void)[] = [];

function mount(renderView: () => JSX.Element): HTMLDivElement {
  return mountTestView(renderView, disposals);
}

function queryTextarea(
  container: ParentNode,
  selector: string,
): HTMLTextAreaElement {
  const prompt = container.querySelector(selector);
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError(`The prompt ${selector} is not a textarea`);
  }
  return prompt;
}

function credential() {
  return {
    accountId: null,
    id: "credential-1",
    isDefault: true,
    label: "Primary",
    source: "api_key" as const,
  };
}

function shortcutRegistry(platform: "mac" | "other"): KeyboardShortcutRegistry {
  const registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform,
  });
  disposals.push(() => {
    registry.dispose();
  });
  return registry;
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("Ctrl+Enter submits valid new sessions and leaves invalid forms native", () => {
  const state = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    draft: {
      ...initialSessionViewState().draft,
      credential: "openai:credential-1",
      model: "model-1",
      prompt: "Implement shortcuts",
      runnerId: "runner-1",
    },
    modelDiscovery: {
      catalog: {
        defaultModel: "model-1",
        models: [
          {
            contextWindow: 128_000,
            id: "model-1",
            inputModalities: ["text"],
            label: "Model one",
            outputModalities: ["text"],
            pricing: null,
            reasoningEfforts: [],
          },
        ],
      },
      credential: "openai:credential-1",
      error: undefined,
      loading: false,
    },
    sessions: [],
  });
  const controller = new SessionController(state);
  const create = vi.spyOn(controller, "create").mockResolvedValue();
  const registry = shortcutRegistry("other");
  const container = mount(() => (
    <ShortcutProvider registry={registry}>
      <SessionPanel
        controller={controller}
        openAi={() => createProviderViewState([credential()])}
        openRouter={() => createProviderViewState([])}
        runners={() => createRunnerViewState([runnerSummary(1)])}
      />
    </ShortcutProvider>
  ));
  const prompt = queryTextarea(container, "#session-prompt");
  const startButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent.includes("Start session"),
  );
  if (startButton === undefined) {
    throw new TypeError("The Start session button was not rendered");
  }

  const enter = shortcutKeyEvent(prompt, "Enter");
  const shiftEnter = shortcutKeyEvent(prompt, "Enter", { shiftKey: true });
  const controlShiftEnter = shortcutKeyEvent(prompt, "Enter", {
    ctrlKey: true,
    shiftKey: true,
  });
  const controlEnter = shortcutKeyEvent(prompt, "Enter", { ctrlKey: true });
  state.setState({
    ...state.state(),
    draft: { ...state.state().draft, prompt: "" },
  });
  const emptyControlEnter = shortcutKeyEvent(prompt, "Enter", {
    ctrlKey: true,
  });

  expect(create).toHaveBeenCalledOnce();
  expect(startButton.getAttribute("aria-keyshortcuts")).toBeNull();
  expect(enter.defaultPrevented).toBe(false);
  expect(shiftEnter.defaultPrevented).toBe(false);
  expect(controlShiftEnter.defaultPrevented).toBe(false);
  expect(controlEnter.defaultPrevented).toBe(true);
  expect(emptyControlEnter.defaultPrevented).toBe(false);
});

test("Cmd+Enter sends an available follow-up and ignores pending or composing input", () => {
  const detail = { ...TEST_SESSION_DETAIL, status: "idle" as const };
  const reactive = sessionDetailState(detail);
  reactive.setState({ ...reactive.state(), followUp: "Please continue" });
  const controller = new SessionController(reactive);
  const send = vi.spyOn(controller, "send").mockResolvedValue();
  const registry = shortcutRegistry("mac");
  const container = mount(() => (
    <ShortcutProvider registry={registry}>
      <SessionDetail controller={controller} state={reactive.state()} />
    </ShortcutProvider>
  ));
  const prompt = queryTextarea(container, "textarea[name='prompt']");
  const sendButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent.includes("Send"),
  );
  if (sendButton === undefined) {
    throw new TypeError("The Send button was not rendered");
  }

  const enter = shortcutKeyEvent(prompt, "Enter");
  const shiftEnter = shortcutKeyEvent(prompt, "Enter", { shiftKey: true });
  const composing = shortcutKeyEvent(prompt, "Enter", {
    isComposing: true,
    metaKey: true,
  });
  const commandEnter = shortcutKeyEvent(prompt, "Enter", { metaKey: true });
  reactive.setState({
    ...reactive.state(),
    followUp: "",
    followUpImages: [],
  });
  const emptyCommandEnter = shortcutKeyEvent(prompt, "Enter", {
    metaKey: true,
  });
  expect(sendButton.getAttribute("aria-keyshortcuts")).toBeNull();
  reactive.setState({
    ...reactive.state(),
    followUp: "Please continue",
    sending: true,
  });
  const pendingCommandEnter = shortcutKeyEvent(prompt, "Enter", {
    metaKey: true,
  });

  expect(send).toHaveBeenCalledOnce();
  expect(enter.defaultPrevented).toBe(false);
  expect(shiftEnter.defaultPrevented).toBe(false);
  expect(composing.defaultPrevented).toBe(false);
  expect(commandEnter.defaultPrevented).toBe(true);
  expect(emptyCommandEnter.defaultPrevented).toBe(false);
  expect(pendingCommandEnter.defaultPrevented).toBe(false);
});

test("Ctrl+Shift+Enter continues with or without follow-up input", () => {
  const detail = { ...TEST_SESSION_DETAIL, status: "idle" as const };
  const reactive = sessionDetailState(detail);
  const controller = new SessionController(reactive);
  const continueSession = vi
    .spyOn(controller, "continueSession")
    .mockResolvedValue();
  const registry = shortcutRegistry("other");
  const container = mount(() => (
    <ShortcutProvider registry={registry}>
      <SessionDetail controller={controller} state={reactive.state()} />
    </ShortcutProvider>
  ));
  const prompt = queryTextarea(container, "textarea[name='prompt']");
  const continueButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent.includes("Continue"),
  );
  if (continueButton === undefined) {
    throw new TypeError("The Continue button was not rendered");
  }

  const shiftEnter = shortcutKeyEvent(prompt, "Enter", { shiftKey: true });
  const controlShiftEnter = shortcutKeyEvent(prompt, "Enter", {
    ctrlKey: true,
    shiftKey: true,
  });
  reactive.setState({ ...reactive.state(), followUp: "Draft instruction" });
  const draftControlShiftEnter = shortcutKeyEvent(prompt, "Enter", {
    ctrlKey: true,
    shiftKey: true,
  });
  expect(registry.available().map(({ action }) => action)).toContain(
    "continue-session",
  );
  expect(continueButton.getAttribute("aria-keyshortcuts")).toBe(
    "Control+Shift+Enter",
  );
  expect(continueButton.disabled).toBe(false);
  reactive.setState({
    ...reactive.state(),
    sending: true,
  });
  const pendingControlShiftEnter = shortcutKeyEvent(prompt, "Enter", {
    ctrlKey: true,
    shiftKey: true,
  });

  expect(continueSession).toHaveBeenCalledTimes(2);
  expect(shiftEnter.defaultPrevented).toBe(false);
  expect(controlShiftEnter.defaultPrevented).toBe(true);
  expect(draftControlShiftEnter.defaultPrevented).toBe(true);
  expect(pendingControlShiftEnter.defaultPrevented).toBe(false);
  expect(continueButton.getAttribute("aria-keyshortcuts")).toBeNull();
  expect(continueButton.disabled).toBe(true);
});
