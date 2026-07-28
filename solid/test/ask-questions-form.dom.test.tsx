import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import type { AskQuestionAnswers } from "../../shared/ask-questions.ts";
import { AskQuestionsForm } from "../ask-questions-client.tsx";
import { PENDING_QUESTIONS_FIXTURE } from "./ask-questions-fixtures.ts";
import {
  disposeTestViews,
  queryTestElementAs,
  setTestInputValue,
} from "./dom-test-helpers.ts";

const disposals: (() => void)[] = [];

function mountForm(): {
  readonly container: HTMLDivElement;
  readonly setSubmitting: (submitting: boolean) => void;
  readonly submitted: ReturnType<
    typeof vi.fn<(value: AskQuestionAnswers) => void>
  >;
} {
  const container = document.createElement("div");
  const submitted = vi.fn<(value: AskQuestionAnswers) => void>();
  const [submitting, setSubmitting] = createSignal(false);
  const view = (): JSX.Element => (
    <AskQuestionsForm
      onSubmit={submitted}
      pending={PENDING_QUESTIONS_FIXTURE}
      submitting={submitting()}
    />
  );
  document.body.append(container);
  disposals.push(render(view, container));
  return { container, setSubmitting, submitted };
}

function fillTextareas(
  container: ParentNode,
  values: readonly string[],
  selector = "textarea",
): void {
  const textareas = Array.from(
    container.querySelectorAll<HTMLTextAreaElement>(selector),
  );
  expect(textareas).toHaveLength(values.length);
  for (const [index, value] of values.entries()) {
    const textarea = textareas[index];
    if (textarea === undefined) {
      throw new Error("Missing ask_questions textarea");
    }
    setTestInputValue(textarea, value);
  }
}

function submitForm(container: ParentNode): void {
  queryTestElementAs(container, "form", HTMLFormElement).requestSubmit();
}

function expectSubmitted(
  submitted: ReturnType<typeof vi.fn<(value: AskQuestionAnswers) => void>>,
  values: readonly AskQuestionAnswers["answers"][number]["value"][],
): void {
  expect(submitted).toHaveBeenCalledWith({
    answers: PENDING_QUESTIONS_FIXTURE.questions.map((question, index) => ({
      questionId: question.id,
      value: values[index] ?? "",
    })),
  });
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("validates and submits selections from mounted controls", () => {
  const { container, submitted } = mountForm();
  const form = queryTestElementAs(container, "form", HTMLFormElement);
  const submit = queryTestElementAs(
    container,
    "button[type='submit']",
    HTMLButtonElement,
  );

  expect(submit.disabled).toBe(true);
  setTestInputValue(
    queryTestElementAs(container, "textarea", HTMLTextAreaElement),
    "  context  ",
  );
  queryTestElementAs(
    container,
    "input[name='direction'][value='proceed']",
    HTMLInputElement,
  ).click();
  queryTestElementAs(
    container,
    "input[value='tests']",
    HTMLInputElement,
  ).click();
  expect(submit.disabled).toBe(false);

  form.requestSubmit();
  expectSubmitted(submitted, ["  context  ", "proceed", ["tests"]]);
});

test("submits custom choice answers without requiring selections", () => {
  const { container, submitted } = mountForm();
  const submit = queryTestElementAs(
    container,
    "button[type='submit']",
    HTMLButtonElement,
  );
  fillTextareas(container, [
    "context",
    "  pause instead  ",
    "run security scan",
  ]);
  expect(submit.disabled).toBe(false);

  submitForm(container);
  expectSubmitted(submitted, [
    "context",
    "  pause instead  ",
    "run security scan",
  ]);
});

test("a custom choice answer overrides a selected option", () => {
  const { container, submitted } = mountForm();
  setTestInputValue(
    queryTestElementAs(container, "textarea", HTMLTextAreaElement),
    "context",
  );
  queryTestElementAs(
    container,
    "input[name='direction'][value='proceed']",
    HTMLInputElement,
  ).click();
  fillTextareas(
    container,
    ["pause instead", "security scan"],
    "textarea[placeholder='Or type your own answer…']",
  );

  submitForm(container);
  expectSubmitted(submitted, ["context", "pause instead", "security scan"]);
  expect(
    queryTestElementAs(
      container,
      "input[name='direction'][value='proceed']",
      HTMLInputElement,
    ).checked,
  ).toBe(false);
});

test("disables all controls and ignores submit while submitting", () => {
  const { container, setSubmitting, submitted } = mountForm();
  setSubmitting(true);
  const controls = Array.from(
    container.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >("button, input, textarea"),
  );

  expect(controls.every(({ disabled }) => disabled)).toBe(true);
  queryTestElementAs(container, "form", HTMLFormElement).dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true }),
  );
  expect(submitted).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Submitting answers…");
});

test("prevents a multi-choice answer from exceeding its maximum", () => {
  const { container } = mountForm();
  const tests = queryTestElementAs(
    container,
    "input[value='tests']",
    HTMLInputElement,
  );
  const lint = queryTestElementAs(
    container,
    "input[value='lint']",
    HTMLInputElement,
  );

  tests.click();
  expect(lint.disabled).toBe(true);
  expect(tests.disabled).toBe(false);
  tests.click();
  expect(lint.disabled).toBe(false);
});
