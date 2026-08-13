import { createSignal } from "solid-js";
import { expect, test, vi } from "vitest";
import { SessionPromptInput } from "../session-client-forms.tsx";
import {
  mountTestView,
  setTestInputValue,
  useFakeTestClock,
} from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";

const disposals = trackedDisposals();

function mountPromptInput() {
  useFakeTestClock(disposals);
  const [prompt, setPrompt] = createSignal("");
  const onInput = vi.fn((value: string) => {
    setPrompt(value);
  });
  const submitted = vi.fn((event: SubmitEvent) => {
    event.preventDefault();
  });
  const container = mountTestView(
    () => (
      <form onSubmit={submitted}>
        <SessionPromptInput
          disabled={false}
          images={[]}
          onAddImages={() => undefined}
          onInput={onInput}
          onKeyDown={() => undefined}
          onRemoveImage={() => undefined}
          prompt={prompt()}
        />
        <button type="submit">Create</button>
      </form>
    ),
    disposals,
  );
  const form = container.querySelector("form");
  const textarea = container.querySelector("#session-prompt");
  const submit = container.querySelector("button[type='submit']");
  if (!(form instanceof HTMLFormElement)) {
    throw new TypeError("The prompt form is unavailable");
  }
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new TypeError("The session prompt is not a textarea");
  }
  if (!(submit instanceof HTMLButtonElement)) {
    throw new TypeError("The submit button is unavailable");
  }
  return {
    container,
    form,
    onInput,
    prompt,
    setPrompt,
    submit,
    submitted,
    textarea,
  };
}

function expectFlushedBeforeSubmit(
  onInput: ReturnType<typeof vi.fn>,
  submitted: ReturnType<typeof vi.fn>,
  prompt: string,
): void {
  expect(onInput).toHaveBeenCalledWith(prompt);
  expect(submitted).toHaveBeenCalledTimes(1);
  const order = onInput.mock.invocationCallOrder[0] ?? Number.NaN;
  const submitOrder = submitted.mock.invocationCallOrder[0] ?? Number.NaN;
  expect(order).toBeLessThan(submitOrder);
}

test("new-session typing echoes locally before the shared draft", () => {
  const { onInput, textarea } = mountPromptInput();

  // Firefox froze because every keystroke patched the whole session view
  // state; the textarea now updates from a local signal and syncs later.
  // Keystrokes arrive in separate tasks, so advance real time between
  // them: each next key must land inside the delay and reset it.
  setTestInputValue(textarea, "Fix");
  vi.advanceTimersByTime(100);
  setTestInputValue(textarea, "Fix the");
  vi.advanceTimersByTime(100);
  setTestInputValue(textarea, "Fix the app");
  vi.advanceTimersByTime(149);

  expect(textarea.value).toBe("Fix the app");
  expect(onInput).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);

  expect(onInput).toHaveBeenCalledTimes(1);
  expect(onInput).toHaveBeenCalledWith("Fix the app");
});

test("form submission flushes pending typing even while focused", () => {
  const { form, onInput, submitted, textarea } = mountPromptInput();

  setTestInputValue(textarea, "Create me now");
  textarea.focus();
  // requestSubmit, button.click(), and assistive tech all reach the form
  // submit event without blurring the textarea first.
  form.requestSubmit();

  expectFlushedBeforeSubmit(onInput, submitted, "Create me now");
});

test("clicking Create flushes without a blur", () => {
  const { onInput, submit, submitted, textarea } = mountPromptInput();

  setTestInputValue(textarea, "Fix the flaky login test");
  textarea.focus();
  // macOS Firefox and Safari do not focus (or blur) on button click, so
  // the click path must flush through the form submit event alone.
  submit.click();

  expect(document.activeElement).toBe(textarea);
  expectFlushedBeforeSubmit(onInput, submitted, "Fix the flaky login test");
});

test("an external insert wins over pending typing", () => {
  const { onInput, setPrompt, textarea } = mountPromptInput();

  setTestInputValue(textarea, "half-typed dra");
  textarea.focus();
  // insertPrompt acknowledges success to its caller, so the inserted body
  // must replace in-flight typing instead of being overwritten later.
  setPrompt("Inserted task body");

  expect(textarea.value).toBe("Inserted task body");
  vi.runAllTimers();
  expect(onInput).not.toHaveBeenCalled();
});

// The capture-phase submit listener covers click submits; blur flushes on
// tab-away, and the composer shortcut covers keyboard submits.
test.each([
  [
    "blur",
    (textarea: HTMLTextAreaElement) => {
      textarea.dispatchEvent(new FocusEvent("blur"));
    },
  ],
  [
    "the composer shortcut",
    (textarea: HTMLTextAreaElement) => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "Enter",
        }),
      );
    },
  ],
] as const)("%s flushes the draft before submission", (_name, flush) => {
  const { onInput, textarea } = mountPromptInput();

  setTestInputValue(textarea, "Submit me");
  flush(textarea);

  expect(onInput).toHaveBeenCalledWith("Submit me");
});

test("external draft replacement updates an unfocused textarea", () => {
  const { setPrompt, textarea } = mountPromptInput();

  // insertPrompt and post-create draft clearing write the shared draft
  // directly; the local echo must follow when no typing is pending.
  setPrompt("Inserted from the outside");
  expect(textarea.value).toBe("Inserted from the outside");

  setPrompt("");
  expect(textarea.value).toBe("");
});
