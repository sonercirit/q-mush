import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import {
  activeSessionDuration,
  formatSessionDuration,
} from "../shared/session-timing.ts";

export function SessionActiveTime(props: {
  readonly session: Pick<
    AgentSessionSummary,
    "activeDurationMs" | "activeStartedAt"
  >;
}): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.session.activeStartedAt === null) {
      setNow(Date.now());
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    onCleanup(() => {
      window.clearInterval(timer);
    });
  });

  return (
    <span>{`Time: ${formatSessionDuration(activeSessionDuration(props.session, now()))}`}</span>
  );
}
