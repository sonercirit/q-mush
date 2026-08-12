import { expect, test, vi } from "vitest";
import { createProviderViewState } from "../provider-credential-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import {
  mountTestView,
  queryTestElementAs,
  useFakeTestClock,
} from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionClientTestState } from "./session-client-test-state.ts";

const disposals = trackedDisposals();

function mountNewSessionForm() {
  useFakeTestClock(disposals);
  const controller = new SessionController(
    createReactiveState<SessionViewState>(sessionClientTestState()),
  );
  const openAiCredential = {
    accountId: null,
    id: "credential-1",
    isDefault: true,
    label: "OpenAI",
    source: "api_key",
  } as const;
  const onlineRunners = createRunnerViewState([runnerSummary(1)]);
  const renderPanel = () =>
    SessionPanel({
      controller,
      openAi: () => createProviderViewState([openAiCredential]),
      openRouter: () => createProviderViewState([]),
      runners: () => onlineRunners,
    });
  const container = mountTestView(renderPanel, disposals);
  return { container, controller };
}

function mountedDraftInput(selector: string): {
  readonly controller: SessionController;
  readonly input: HTMLInputElement;
} {
  const { container, controller } = mountNewSessionForm();
  const input = queryTestElementAs(container, selector, HTMLInputElement);
  input.focus();
  return { controller, input };
}

function typeValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  const typed = new InputEvent("input", { bubbles: true });
  input.dispatchEvent(typed);
}

// The prompt textarea froze Firefox first, but every draft field that
// patches the whole view state per keystroke shares the mechanism; the
// optional inputs echo locally and sync on the same delay.
test.each([
  {
    field: "session-agent-file-path",
    first: "AGENTS.md",
    read: (controller: SessionController) =>
      controller.state.draft.agentFilePath ?? "",
    second: "AGENTS.md.bak",
  },
  {
    field: "session-context-token-cap",
    first: "120000",
    read: (controller: SessionController) =>
      controller.state.draft.userContextTokenCap,
    second: "150000",
  },
])(
  "$field typing debounces into the draft and flushes on blur",
  ({ field, first, read, second }) => {
    const { controller, input } = mountedDraftInput(`#${field}`);

    typeValue(input, first);
    expect(input.value).toBe(first);
    expect(read(controller)).toBe("");

    vi.advanceTimersByTime(150);
    expect(read(controller)).toBe(first);

    typeValue(input, second);
    input.dispatchEvent(new FocusEvent("blur"));
    expect(read(controller)).toBe(second);
  },
);

test("form submission flushes pending optional-field typing while focused", () => {
  const { controller, input } = mountedDraftInput("#session-agent-file-path");
  const form = input.form;
  if (form === null) throw new Error("The agent file input has no form");

  typeValue(input, "docs/AGENTS.md");
  const submission = new SubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
  });
  form.dispatchEvent(submission);

  expect(controller.state.draft.agentFilePath).toBe("docs/AGENTS.md");
});
