import { createSignal } from "solid-js";
import { expect, test, vi } from "vitest";
import { SessionPromptInput } from "../session-client-forms.tsx";
import { mountTestView, useFakeTestClock } from "./dom-test-helpers.ts";
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
      </form>
    ),
    disposals,
  );
  const form = container.querySelector("form");
  const textarea = container.querySelector("#session-prompt");
  if (!(form instanceof HTMLFormElement)) {
    throw new TypeError("The prompt form is unavailable");
  }
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new TypeError("The session prompt is not a textarea");
  }
  return { container, form, onInput, prompt, setPrompt, submitted, textarea };
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

test("new-session typing echoes locally before the shared draft", () => {
  const { onInput, textarea } = mountPromptInput();

  // Firefox froze because every keystroke patched the whole session view
  // state; the textarea now updates from a local signal and syncs later.
  // Keystrokes arrive in separate tasks, so advance real time between
  // them: each next key must land inside the delay and reset it.
  type(textarea, "Fix");
  vi.advanceTimersByTime(100);
  type(textarea, "Fix the");
  vi.advanceTimersByTime(100);
  type(textarea, "Fix the app");
  vi.advanceTimersByTime(149);

  expect(textarea.value).toBe("Fix the app");
  expect(onInput).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);

  expect(onInput).toHaveBeenCalledTimes(1);
  expect(onInput).toHaveBeenCalledWith("Fix the app");
});

test("form submission flushes pending typing even while focused", () => {
  const { form, onInput, submitted, textarea } = mountPromptInput();

  type(textarea, "Create me now");
  textarea.focus();
  // requestSubmit, button.click(), and assistive tech all reach the form
  // submit event without blurring the textarea first.
  form.requestSubmit();

  expect(onInput).toHaveBeenCalledWith("Create me now");
  expect(submitted).toHaveBeenCalledTimes(1);
  const order = onInput.mock.invocationCallOrder[0] ?? Number.NaN;
  const submitOrder = submitted.mock.invocationCallOrder[0] ?? Number.NaN;
  expect(order).toBeLessThan(submitOrder);
});

test("an external insert wins over pending typing", () => {
  const { onInput, setPrompt, textarea } = mountPromptInput();

  type(textarea, "half-typed dra");
  textarea.focus();
  // insertPrompt acknowledges success to its caller, so the inserted body
  // must replace in-flight typing instead of being overwritten later.
  setPrompt("Inserted task body");

  expect(textarea.value).toBe("Inserted task body");
  vi.runAllTimers();
  expect(onInput).not.toHaveBeenCalled();
});

// Blur covers the Create-button click path (the button lives outside the
// component); the composer shortcut covers keyboard submits.
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

  type(textarea, "Submit me");
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
