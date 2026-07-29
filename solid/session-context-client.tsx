import { Show, type JSX } from "solid-js";
import type { AgentSessionSummary } from "../shared/session-model.ts";

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }

  const units =
    tokens < 1_000_000
      ? { divisor: 1_000, suffix: "K" }
      : { divisor: 1_000_000, suffix: "M" };
  const scaled = tokens / units.divisor;
  const value =
    scaled >= 100 || Number.isInteger(scaled)
      ? scaled.toFixed(0)
      : scaled.toFixed(1);
  return `${value}${units.suffix}`;
}

function contextPercentage(
  currentContextTokens: number,
  maxContextTokens: number | null,
): number | null {
  return maxContextTokens === null
    ? null
    : Math.min(
        100,
        Math.round((currentContextTokens / maxContextTokens) * 100),
      );
}

export function sessionContextLabel(
  session: Pick<
    AgentSessionSummary,
    "currentContextTokens" | "maxContextTokens" | "status"
  >,
): string {
  const current =
    session.currentContextTokens === 0
      ? session.status === "queued" ||
        session.status === "running" ||
        session.status === "paused"
        ? "Pending"
        : "Not reported"
      : formatTokenCount(session.currentContextTokens);
  const percentage = contextPercentage(
    session.currentContextTokens,
    session.maxContextTokens,
  );
  const suffix = percentage === null ? "" : ` (${String(percentage)}%)`;
  return `Context: ${current} / ${session.maxContextTokens === null ? "Not reported" : formatTokenCount(session.maxContextTokens)}${suffix}`;
}

export function sessionContextClasses(
  session: Pick<
    AgentSessionSummary,
    "currentContextTokens" | "maxContextTokens"
  >,
): string {
  const percentage = contextPercentage(
    session.currentContextTokens,
    session.maxContextTokens,
  );
  if (percentage === null) {
    return "text-slate-500";
  }

  return percentage >= 90
    ? "text-rose-200"
    : percentage >= 80
      ? "text-amber-200"
      : "text-slate-500";
}

export function CompactionControls(props: {
  readonly compacting: boolean;
  readonly continueAvailable: boolean;
  readonly disabled?: boolean;
  readonly onCompact: (continueAfter?: boolean) => void;
}): JSX.Element {
  const disabled = (): boolean => props.disabled ?? props.compacting;
  const button = (label: string, continueAfter = false) => (
    <button
      class="min-h-11 rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50"
      disabled={disabled()}
      onClick={() => {
        props.onCompact(continueAfter);
      }}
      type="button"
    >
      {props.compacting ? "Compacting…" : label}
    </button>
  );
  return (
    <>
      {button("Compact")}
      <Show when={props.continueAvailable}>
        {button("Compact and continue", true)}
      </Show>
    </>
  );
}
