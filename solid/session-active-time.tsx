import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type JSX,
} from "solid-js";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import {
  activeSessionDuration,
  formatSessionDuration,
} from "../shared/session-timing.ts";

interface SessionClock {
  now(): number;
  subscribe(): () => void;
}

type SessionTimeProps = Pick<
  AgentSessionSummary,
  "activeDurationMs" | "activeStartedAt"
>;

const SessionClockContext = createContext<SessionClock>();

export function SessionClockProvider(props: {
  readonly children: JSX.Element;
}): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  let runningCount = 0;
  let timer: number | undefined;
  const stop = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
  const start = (): void => {
    if (timer !== undefined) {
      return;
    }
    setNow(Date.now());
    timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
  };
  onCleanup(stop);
  const clock: SessionClock = {
    now,
    subscribe: () => {
      runningCount += 1;
      start();
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        runningCount = Math.max(0, runningCount - 1);
        if (runningCount === 0) {
          stop();
        }
      };
    },
  };
  return (
    <SessionClockContext.Provider value={clock}>
      {props.children}
    </SessionClockContext.Provider>
  );
}

export function SessionActiveTime(props: {
  readonly session: SessionTimeProps;
}): JSX.Element {
  const sharedClock = useContext(SessionClockContext);
  const [localNow, setLocalNow] = createSignal(Date.now());
  const now = (): number => sharedClock?.now() ?? localNow();
  createEffect(() => {
    const running = props.session.activeStartedAt !== null;
    if (sharedClock !== undefined) {
      if (running) {
        onCleanup(sharedClock.subscribe());
      }
      return;
    }
    if (!running) {
      setLocalNow(Date.now());
      return;
    }

    setLocalNow(Date.now());
    const timer = window.setInterval(() => {
      setLocalNow(Date.now());
    }, 1_000);
    onCleanup(() => {
      window.clearInterval(timer);
    });
  });

  return (
    <span>{`Time: ${formatSessionDuration(activeSessionDuration(props.session, now()))}`}</span>
  );
}
