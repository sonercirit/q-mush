import { For, Show, type JSX } from "solid-js";
import type {
  ProviderLimitDimension,
  ProviderLimitState,
} from "../shared/provider-limits.ts";

function formatValue(dimension: ProviderLimitDimension, value: number): string {
  switch (dimension.unit) {
    case "credits":
      return `$${value.toFixed(2)}`;
    case "percent":
      return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
    case "requests":
    case "tokens":
      return new Intl.NumberFormat().format(value);
  }
}

function percentage(dimension: ProviderLimitDimension): number | null {
  return dimension.limit !== null &&
    dimension.limit > 0 &&
    dimension.remaining !== null
    ? Math.max(0, Math.min(100, (dimension.remaining / dimension.limit) * 100))
    : null;
}

function remainingText(dimension: ProviderLimitDimension): string {
  if (dimension.remaining === null) {
    if (dimension.used !== undefined && dimension.used !== null) {
      return `${formatValue(dimension, dimension.used)} used; provider did not expose a remaining amount`;
    }
    return dimension.limit === null
      ? "Remaining amount unavailable"
      : `Limit ${formatValue(dimension, dimension.limit)}; remaining unavailable`;
  }
  return dimension.limit === null
    ? `${formatValue(dimension, dimension.remaining)} remaining`
    : `${formatValue(dimension, dimension.remaining)} of ${formatValue(dimension, dimension.limit)} remaining`;
}

function formatTimestamp(value: number): string | null {
  try {
    const formatted = new Date(value).toLocaleString();
    return formatted === "Invalid Date" ? null : formatted;
  } catch {
    return null;
  }
}

function resetText(resetAt: number | null, now: number): string | null {
  if (resetAt === null) {
    return null;
  }
  const timestamp = formatTimestamp(resetAt);
  if (timestamp === null) {
    return null;
  }
  const difference = resetAt - now;
  if (difference <= 0) {
    return `Reset was ${timestamp}`;
  }
  const minutes = Math.ceil(difference / 60_000);
  const countdown =
    minutes < 60
      ? `${String(minutes)}m`
      : minutes < 1_440
        ? `${String(Math.ceil(minutes / 60))}h`
        : `${String(Math.ceil(minutes / 1_440))}d`;
  return `Resets in ${countdown} (${timestamp})`;
}

function warning(percent: number | null): {
  readonly classes: string;
  readonly label: string | null;
} {
  if (percent !== null && percent <= 10) {
    return {
      classes: "border-rose-300/30 bg-rose-300/10",
      label: "Critical: nearly exhausted",
    };
  }
  if (percent !== null && percent <= 20) {
    return {
      classes: "border-amber-300/30 bg-amber-300/10",
      label: "Warning: running low",
    };
  }
  return { classes: "border-white/10 bg-white/[0.04]", label: null };
}

function LimitDimension(props: {
  readonly dimension: ProviderLimitDimension;
  readonly now: number;
}): JSX.Element {
  const percent = (): number | null => percentage(props.dimension);
  const presentation = () => warning(percent());
  const reset = () => resetText(props.dimension.resetAt, props.now);
  return (
    <li class={`rounded-xl border p-3 ${presentation().classes}`}>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <span class="text-xs font-semibold text-slate-200">
          {props.dimension.label}
        </span>
        <Show when={presentation().label}>
          {(label) => (
            <span class="text-[0.68rem] font-semibold text-amber-100">
              {label()}
            </span>
          )}
        </Show>
      </div>
      <p class="mt-1 text-xs text-slate-400">
        {remainingText(props.dimension)}
      </p>
      <Show when={percent() !== null}>
        <div class="mt-2">
          <progress
            aria-label={`${props.dimension.label} remaining`}
            class="h-1.5 w-full accent-emerald-300"
            max="100"
            value={percent() ?? undefined}
          />
          <span class="sr-only">{`${String(percent() ?? 0)}% remaining`}</span>
        </div>
      </Show>
      <Show when={reset()}>
        {(text) => <p class="mt-1 text-[0.68rem] text-slate-500">{text()}</p>}
      </Show>
    </li>
  );
}

function observationText(
  limits: Extract<ProviderLimitState, { readonly status: "available" }>,
): string {
  const timestamp = formatTimestamp(limits.observedAt);
  const source =
    limits.source === "websocket_event"
      ? "Provider WebSocket event"
      : limits.source === "response_event"
        ? "Provider response event"
        : limits.source === "credential_metadata"
          ? "Provider credential metadata"
          : "Provider response headers";
  return `${limits.stale ? "Stale observation" : "Last observed"}${timestamp === null ? "" : `: ${timestamp}`}. ${source}.`;
}

export function RemainingLimits(props: {
  readonly compact?: boolean;
  readonly limits: ProviderLimitState;
  readonly now?: number;
}): JSX.Element {
  const now = (): number => props.now ?? Date.now();
  return (
    <section
      aria-label="Remaining limits"
      class={props.compact === true ? "mt-3" : "mt-4"}
    >
      <h4 class="text-xs font-semibold tracking-wide text-slate-300 uppercase">
        Remaining limits
      </h4>
      <Show
        fallback={
          <p class="mt-2 text-xs leading-5 text-slate-500">
            The provider has not exposed limit metadata for this credential yet.
          </p>
        }
        when={props.limits.status === "available" ? props.limits : undefined}
      >
        {(limits) => (
          <>
            <ul class="mt-2 grid gap-2 sm:grid-cols-2">
              <For each={limits().dimensions}>
                {(dimension) => (
                  <LimitDimension dimension={dimension} now={now()} />
                )}
              </For>
            </ul>
            <p class="mt-2 text-[0.68rem] text-slate-500">
              {observationText(limits())}
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
