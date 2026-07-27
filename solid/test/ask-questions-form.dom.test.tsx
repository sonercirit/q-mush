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
