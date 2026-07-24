import { createSignal, type JSX } from "solid-js";

export interface SessionShortcut {
  readonly followUpKeys: string;
  readonly followUpLabel: string;
  readonly steerKeys: string;
  readonly steerLabel: string;
}

const CONTROL_SHORTCUTS: SessionShortcut = {
  followUpKeys: "Control+Enter",
  followUpLabel: "Ctrl+Enter",
  steerKeys: "Control+Shift+Enter",
  steerLabel: "Ctrl+Shift+Enter",
};

function platformSessionShortcuts(platform: string): SessionShortcut {
  return /Mac|iPhone|iPad|iPod/u.test(platform)
    ? {
        followUpKeys: "Meta+Enter",
        followUpLabel: "⌘+Enter",
        steerKeys: "Meta+Shift+Enter",
        steerLabel: "⌘+Shift+Enter",
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
    (platform) => setShortcuts(platformSessionShortcuts(platform)),
  ];
}

export function SessionPendingInputs(props: {
  readonly inputs: readonly {
    readonly content: string;
    readonly images: readonly unknown[];
    readonly kind: "follow_up" | "steer";
  }[];
}): JSX.Element {
  return props.inputs.length === 0 ? null : (
    <section
      aria-label="Queued session inputs"
      class="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4"
    >
      <h4 class="text-sm font-semibold text-amber-200">Pending instructions</h4>
      <ol class="mt-3 space-y-2">
        {props.inputs.map((input) => (
          <li class="rounded-xl border border-white/10 bg-slate-950/70 p-3">
            <p class="text-xs font-semibold tracking-wide text-amber-200 uppercase">
              {input.kind === "steer" ? "Queued steer" : "Queued follow up"}
            </p>
            {input.content.length > 0 ? (
              <p class="mt-2 whitespace-pre-wrap text-sm text-slate-300">
                {input.content}
              </p>
            ) : null}
            {input.images.length > 0 ? (
              <p class="mt-2 text-xs text-slate-500">
                {`${String(input.images.length)} attached image${input.images.length === 1 ? "" : "s"}`}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
