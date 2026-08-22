import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

const COPY_FEEDBACK_DURATION_MS = 2_000;

type ClipboardCopyState = "copied" | "failed" | "idle";

export function clipboardCopyLabel(
  state: ClipboardCopyState,
  idle: string,
): string {
  switch (state) {
    case "copied":
      return "Copied!";
    case "failed":
      return "Copy failed";
    case "idle":
      return idle;
  }
}

interface ClipboardCopy {
  readonly copy: () => Promise<void>;
  readonly state: Accessor<ClipboardCopyState>;
}

export function createClipboardCopy(text: Accessor<string>): ClipboardCopy {
  const [state, setState] = createSignal<ClipboardCopyState>("idle");
  let feedbackTimer: number | undefined;
  let textRevision = 0;
  let copySequence = 0;
  const clearFeedback = (): void => {
    if (feedbackTimer !== undefined) {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = undefined;
    }
  };
  createEffect(() => {
    text();
    textRevision += 1;
    copySequence += 1;
    clearFeedback();
    setState("idle");
  });
  const copy = async (): Promise<void> => {
    clearFeedback();
    const sequence = ++copySequence;
    const revision = textRevision;
    const value = text();
    try {
      await navigator.clipboard.writeText(value);
      if (sequence !== copySequence || revision !== textRevision) return;
      setState("copied");
    } catch {
      if (sequence !== copySequence || revision !== textRevision) return;
      setState("failed");
    }
    feedbackTimer = window.setTimeout(() => {
      setState("idle");
      feedbackTimer = undefined;
    }, COPY_FEEDBACK_DURATION_MS);
  };
  onCleanup(clearFeedback);
  return { copy, state };
}
