import { Show, type JSX } from "solid-js";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import {
  activeSessionDuration,
  formatSessionTime,
} from "../shared/session-timing.ts";
import { tokenCacheRate } from "../shared/session-token-usage.ts";
import { createLiveNow } from "./live-now.ts";

export function TranscriptStepTiming(props: {
  readonly endedAt: number | null;
  readonly startedAt: number;
  readonly tokenUsage?: AgentSessionMessage["tokenUsage"];
}): JSX.Element {
  const now = createLiveNow(() => props.endedAt === null);
  const duration = (): number =>
    activeSessionDuration(
      { activeDurationMs: 0, activeStartedAt: props.startedAt },
      props.endedAt ?? now(),
    );
  const time = (value: number): JSX.Element => {
    const date = new Date(value);
    return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
  };
  const cacheRate = (): number | null =>
    props.tokenUsage === null || props.tokenUsage === undefined
      ? null
      : tokenCacheRate(props.tokenUsage);
  return (
    <p
      class="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs text-slate-500"
      data-step-timing={props.endedAt === null ? "active" : "completed"}
    >
      <span>{`Duration: ${formatSessionTime(duration())}`}</span>
      <Show when={cacheRate() !== null}>
        <span>{`Cache: ${String(Math.round((cacheRate() ?? 0) * 100))}%`}</span>
      </Show>
      <span>Started: {time(props.startedAt)}</span>
      <Show when={props.endedAt}>
        {(endedAt) => <span>Ended: {time(endedAt())}</span>}
      </Show>
    </p>
  );
}
