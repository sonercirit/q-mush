import { createSignal, onCleanup, type Accessor } from "solid-js";

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
  const copy = async (): Promise<void> => {
    if (feedbackTimer !== undefined) {
      window.clearTimeout(feedbackTimer);
    }
    try {
      await navigator.clipboard.writeText(text());
      setState("copied");
    } catch {
      setState("failed");
    }
    feedbackTimer = window.setTimeout(() => {
      setState("idle");
      feedbackTimer = undefined;
    }, COPY_FEEDBACK_DURATION_MS);
  };
  onCleanup(() => {
    if (feedbackTimer !== undefined) {
      window.clearTimeout(feedbackTimer);
    }
  });
  return { copy, state };
}
