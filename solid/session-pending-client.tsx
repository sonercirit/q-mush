import { createSignal, For, Show, type JSX } from "solid-js";
import {
  renderPlainText,
  renderStructuredText,
} from "./session-structured-text.tsx";

interface DisplayPendingInput {
  readonly clientRequestId: string;
  readonly content: string;
  readonly createdAt?: number;
  readonly id: string;
  readonly images: readonly unknown[];
  readonly kind: "follow_up" | "steer";
  readonly status?: "sending" | "unconfirmed";
}

export interface SessionShortcut {
  readonly followUpKeys: string;
  readonly followUpLabel: string;
  readonly steerKeys: string;
  readonly steerLabel: string;
}

export type SessionComposerShortcut = "follow_up" | "steer";

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

/** @public Resolves a composer key event to its platform-independent action. */
export function sessionComposerShortcut(
  event: Pick<
    KeyboardEvent,
    "ctrlKey" | "isComposing" | "key" | "metaKey" | "shiftKey"
  >,
): SessionComposerShortcut | undefined {
  if (
    event.isComposing ||
    event.key !== "Enter" ||
    (!event.ctrlKey && !event.metaKey)
  ) {
    return undefined;
  }
  return event.shiftKey ? "follow_up" : "steer";
}

export function SessionShortcutHint(props: {
  readonly label: string;
}): JSX.Element {
  return (
    <span aria-hidden="true" class="ml-2 text-xs opacity-60">
      {props.label}
    </span>
  );
}

function pendingInputLabel(kind: DisplayPendingInput["kind"]): string {
  return kind === "steer" ? "Queued steer" : "Queued follow up";
}

interface SessionPendingInputsProps {
  readonly inputs: readonly DisplayPendingInput[];
  readonly onCancel: (inputId: string) => void;
  readonly onRetry: (clientRequestId: string) => void;
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
              <li
                class="rounded-xl border border-white/10 bg-slate-950/70 p-3"
                data-pending-input-status={input.status ?? "confirmed"}
              >
                <div class="flex items-start justify-between gap-3">
                  <p class="text-xs font-semibold tracking-wide text-amber-200 uppercase">
                    {`${pendingInputLabel(input.kind)}${input.status === "sending" ? " · Sending…" : input.status === "unconfirmed" ? " · Delivery unconfirmed" : ""}`}
                  </p>
                  <Show when={input.status === "unconfirmed"}>
                    <button
                      class="rounded-lg border border-white/10 px-2 py-1 text-xs font-semibold text-slate-400 transition hover:border-amber-300/30 hover:text-amber-200"
                      onClick={() => {
                        props.onRetry(input.clientRequestId);
                      }}
                      type="button"
                    >
                      Retry
                    </button>
                  </Show>
                  <Show when={input.status === undefined}>
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
                  </Show>
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
