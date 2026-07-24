/* jscpd:ignore-start */
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AskQuestionAnswers,
  PendingAskQuestions,
} from "../../shared/ask-questions.ts";
import { AskQuestionsForm } from "../ask-questions-client.tsx";

const disposals: (() => void)[] = [];

const PENDING: PendingAskQuestions = {
  createdAt: 1,
  id: "request-1",
  questions: [
    {
      id: "detail",
      maxLength: 20,
      minLength: 1,
      prompt: "Add context",
      type: "free_text",
    },
    {
      id: "direction",
      options: [
        { label: "Proceed", value: "proceed" },
        { label: "Stop", value: "stop" },
      ],
      prompt: "Choose a direction",
      type: "single_choice",
    },
    {
      id: "checks",
      maxSelections: 1,
      minSelections: 1,
      options: [
        { label: "Tests", value: "tests" },
        { label: "Lint", value: "lint" },
      ],
      prompt: "Choose one check",
      type: "multi_choice",
    },
  ],
  toolCallId: "call-1",
};

function query<ElementType extends Element>(
  container: ParentNode,
  selector: string,
  constructor: abstract new (...arguments_: never[]) => ElementType,
): ElementType {
  const element = container.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new TypeError(`Missing test element: ${selector}`);
  }
  return element;
}

function setText(element: HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function mountForm(): {
  readonly container: HTMLDivElement;
  readonly setSubmitting: (submitting: boolean) => void;
  readonly submitted: ReturnType<
    typeof vi.fn<(value: AskQuestionAnswers) => void>
  >;
} {
  const container = document.createElement("div");
  const submitted = vi.fn<(value: AskQuestionAnswers) => void>();
  const [pending] = createSignal(PENDING);
  const [submitting, setSubmitting] = createSignal(false);
  const view = (): JSX.Element => (
    <AskQuestionsForm
      onSubmit={submitted}
      pending={pending()}
      submitting={submitting()}
    />
  );
  document.body.append(container);
  disposals.push(render(view, container));
  return { container, setSubmitting, submitted };
}

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
  document.body.replaceChildren();
});

test("validates and submits canonical selections from mounted controls", () => {
  const { container, submitted } = mountForm();
  const form = query(container, "form", HTMLFormElement);
  const submit = query(container, "button[type='submit']", HTMLButtonElement);

  expect(submit.disabled).toBe(true);
  setText(query(container, "textarea", HTMLTextAreaElement), "  context  ");
  query(
    container,
    "input[name='direction'][value='proceed']",
    HTMLInputElement,
  ).click();
  query(container, "input[value='tests']", HTMLInputElement).click();
  expect(submit.disabled).toBe(false);

  form.requestSubmit();
  expect(submitted).toHaveBeenCalledWith({
    answers: [
      { questionId: "detail", value: "  context  " },
      { questionId: "direction", value: "proceed" },
      { questionId: "checks", value: ["tests"] },
    ],
  });
});

test("disables all controls and ignores submit while submitting", () => {
  const { container, setSubmitting, submitted } = mountForm();
  const controls = Array.from(
    container.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >("button, input, textarea"),
  );

  setSubmitting(true);
  expect(controls.every(({ disabled }) => disabled)).toBe(true);
  query(container, "form", HTMLFormElement).dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true }),
  );
  expect(submitted).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Submitting answers…");
});

test("prevents a multi-choice answer from exceeding its maximum", () => {
  const { container } = mountForm();
  const tests = query(container, "input[value='tests']", HTMLInputElement);
  const lint = query(container, "input[value='lint']", HTMLInputElement);

  tests.click();
  expect(lint.disabled).toBe(true);
  expect(tests.disabled).toBe(false);

  tests.click();
  expect(lint.disabled).toBe(false);
});
/* jscpd:ignore-end */
