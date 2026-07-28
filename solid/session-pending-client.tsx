import { createSignal, For, Show, type JSX } from "solid-js";
import {
  renderPlainText,
  renderStructuredText,
} from "./session-structured-text.tsx";

interface DisplayPendingInput {
  readonly content: string;
  readonly createdAt?: number;
  readonly id: string;
  readonly images: readonly unknown[];
  readonly kind: "follow_up" | "steer";
}

export interface SessionShortcut {
  readonly followUpKeys: string;
  readonly followUpLabel: string;
  readonly steerKeys: string;
  readonly steerLabel: string;
}

const CONTROL_SHORTCUTS: SessionShortcut = {
  followUpKeys: "Control+Shift+Enter",
  followUpLabel: "Ctrl+Shift+Enter",
  steerKeys: "Control+Enter",
  steerLabel: "Ctrl+Enter",
};

/** @public Resolves platform-specific session composer shortcuts. */
export function platformSessionShortcuts(platform: string): SessionShortcut {
  return /Mac|iPhone|iPad|iPod/u.test(platform)
    ? {
        followUpKeys: "Meta+Shift+Enter",
        followUpLabel: "⌘+Shift+Enter",
        steerKeys: "Meta+Enter",
        steerLabel: "⌘+Enter",
      }
    : CONTROL_SHORTCUTS;
}

export function createSessionShortcuts(): readonly [
  () => SessionShortcut,
  (platform: string) => void,
] {
  const [shortcuts, setShortcuts] =
    createSignal<SessionShortcut>(CONTROL_SHORTCUTS);
  return [
    shortcuts,
    (platform) => {
      setShortcuts(platformSessionShortcuts(platform));
    },
  ];
}

function pendingInputLabel(kind: DisplayPendingInput["kind"]): string {
  return kind === "steer" ? "Queued steer" : "Queued follow up";
}

interface SessionPendingInputsProps {
  readonly inputs: readonly DisplayPendingInput[];
  readonly onCancel: (inputId: string) => void;
}

export function SessionPendingInputs(
  props: SessionPendingInputsProps,
): JSX.Element {
  return (
    <Show when={props.inputs.length > 0}>
      <section
        aria-label="Queued session inputs"
        class="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4"
      >
        <h4 class="text-sm font-semibold text-amber-200">
          Pending instructions
        </h4>
        <ol class="mt-3 space-y-2">
          <For each={props.inputs}>
            {(input) => (
              <li class="rounded-xl border border-white/10 bg-slate-950/70 p-3">
                <div class="flex items-start justify-between gap-3">
                  <p class="text-xs font-semibold tracking-wide text-amber-200 uppercase">
                    {pendingInputLabel(input.kind)}
                  </p>
                  <button
                    aria-label={`Cancel ${pendingInputLabel(input.kind).toLowerCase()}`}
                    class="rounded-lg border border-white/10 px-2 py-1 text-xs font-semibold text-slate-400 transition hover:border-rose-300/30 hover:text-rose-200"
                    onClick={() => {
                      props.onCancel(input.id);
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
                <Show when={input.content.length > 0}>
                  <div class="mt-2 text-sm text-slate-300">
                    {renderStructuredText(input.content, renderPlainText)}
                  </div>
                </Show>
                <Show when={input.images.length > 0}>
                  <p class="mt-2 text-xs text-slate-500">
                    {`${String(input.images.length)} attached file${input.images.length === 1 ? "" : "s"}`}
                  </p>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
}
