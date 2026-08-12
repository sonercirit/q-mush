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
  const container = mountTestView(
    () => (
      <SessionPromptInput
        disabled={false}
        images={[]}
        onAddImages={() => undefined}
        onInput={onInput}
        onKeyDown={() => undefined}
        onRemoveImage={() => undefined}
        prompt={prompt()}
      />
    ),
    disposals,
  );
  const textarea = container.querySelector("#session-prompt");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new TypeError("The session prompt is not a textarea");
  }
  return { container, onInput, setPrompt, textarea };
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

test("new-session typing echoes locally before the shared draft", () => {
  const { onInput, textarea } = mountPromptInput();

  // Firefox froze because every keystroke patched the whole session view
  // state; the textarea now updates from a local signal and syncs later.
  type(textarea, "Fix");
  type(textarea, "Fix the");
  type(textarea, "Fix the app");

  expect(textarea.value).toBe("Fix the app");
  expect(onInput).not.toHaveBeenCalled();

  vi.runAllTimers();

  expect(onInput).toHaveBeenCalledTimes(1);
  expect(onInput).toHaveBeenCalledWith("Fix the app");
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
