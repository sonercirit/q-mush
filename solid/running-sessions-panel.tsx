import { createMemo, For, Show, type Accessor, type JSX } from "solid-js";
import type { RunnerStatus } from "../shared/runner-model.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { type RunningSessionsController } from "./running-sessions-controller.ts";
import { SessionActiveTime } from "./session-active-time.tsx";

interface RunningSessionRunner {
  readonly id: string;
  readonly name: string | null;
  readonly status: RunnerStatus;
}

interface RunningSessionsPanelProps {
  readonly controller: RunningSessionsController;
  readonly focusSessionList: () => void;
  readonly selectSession: (sessionId: string) => void;
  readonly runners: Accessor<readonly RunningSessionRunner[]>;
}

function countLabel(count: number, label: "Queued" | "Running"): string {
  return `${String(count)} ${label}`;
}

function statusPresentation(status: "queued" | "running"): {
  readonly classes: string;
  readonly label: string;
} {
  return status === "running"
    ? {
        classes: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
        label: "Running",
      }
    : {
        classes: "border-amber-300/25 bg-amber-300/10 text-amber-200",
        label: "Queued",
      };
}

function RunningSessionItem(props: {
  readonly selectSession: (sessionId: string) => void;
  readonly runnerName: string;
  readonly session: AgentSessionSummary;
}): JSX.Element {
  const presentation = () =>
    statusPresentation(
      props.session.status === "running" ? "running" : "queued",
    );

  return (
    <li
      {...renderDebugBoundary(
        `running-session:${props.session.id}`,
        `Active session: ${props.session.title}`,
      )}
    >
      <button
        aria-label={`Open ${props.session.title}`}
        class="group w-full rounded-xl border border-white/10 bg-slate-950/60 p-3 text-left transition hover:border-emerald-300/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
        data-running-session-id={props.session.id}
        onClick={() => {
          props.selectSession(props.session.id);
        }}
        type="button"
      >
        <span class="flex items-start justify-between gap-2">
          <span class="min-w-0 truncate text-sm font-semibold text-white group-hover:text-emerald-100">
            {props.session.title}
          </span>
          <span
            class={`shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${presentation().classes}`}
          >
            {presentation().label}
          </span>
        </span>
        <span class="mt-1 block truncate text-[0.7rem] text-slate-500">
          {`${props.session.provider} · ${props.session.model} · ${props.runnerName}`}
        </span>
        <span class="mt-1 block text-[0.7rem] text-slate-400">
          <SessionActiveTime session={props.session} />
        </span>
      </button>
    </li>
  );
}

function freshnessLabel(
  freshness: "live" | "loading" | "stale",
): string | undefined {
  switch (freshness) {
    case "live":
      return undefined;
    case "loading":
      return "Loading active sessions…";
    case "stale":
      return "Reconnecting — last known status";
  }
}

function panelOverview(state: RunningSessionsPanelProps["controller"]["view"]) {
  return createMemo(
    () =>
      state().overview ?? {
        overflowCount: 0,
        queuedCount: 0,
        runningCount: 0,
        visibleSessions: [],
      },
  );
}

interface PanelState {
  readonly state: RunningSessionsPanelProps["controller"]["view"];
  readonly overview: ReturnType<typeof panelOverview>;
}

function runningSessionsView(
  controller: RunningSessionsController,
): PanelState {
  const state = controller.view;
  return { overview: panelOverview(state), state };
}

function RunningSessionsContent(props: RunningSessionsPanelProps): JSX.Element {
  const view = runningSessionsView(props.controller);
  const state = view.state;
  const overview = view.overview;
  const runners = createMemo(
    () => new Map(props.runners().map((runner) => [runner.id, runner])),
  );
  const runnerName = (runnerId: string): string => {
    const runner = runners().get(runnerId);
    if (runner === undefined) {
      return "Runner unavailable";
    }
    const name =
      runner.name === null || runner.name.trim().length === 0
        ? "Runner"
        : runner.name;
    switch (runner.status) {
      case "offline":
        return `${name} (offline)`;
      case "online":
        return name;
      case "pending":
        return `${name} (setup pending)`;
    }
  };

  return (
    <>
      <div class="flex items-end justify-between gap-3">
        <div>
          <h2
            class="text-[0.65rem] font-semibold tracking-[0.16em] text-slate-500 uppercase"
            id="running-sessions-title"
          >
            Active sessions
          </h2>
          <p class="mt-1 flex items-baseline gap-2">
            <Show
              fallback={
                <span class="text-sm font-semibold text-slate-300">
                  Loading…
                </span>
              }
              when={state().freshness !== "loading"}
            >
              <span class="text-2xl font-semibold text-white">
                {overview().runningCount}
              </span>
              <span class="text-sm font-semibold text-emerald-200">
                Running
              </span>
            </Show>
          </p>
        </div>
        <Show when={state().freshness !== "loading"}>
          <p class="rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-200">
            {countLabel(overview().queuedCount, "Queued")}
          </p>
        </Show>
      </div>
      <p aria-atomic="true" aria-live="polite" class="sr-only" role="status">
        <Show
          fallback="Loading active sessions"
          when={state().freshness !== "loading"}
        >
          {`${countLabel(overview().runningCount, "Running")}; ${countLabel(overview().queuedCount, "Queued")}`}
        </Show>
      </p>
      <Show when={freshnessLabel(state().freshness)}>
        {(label) => (
          <p class="mt-3 text-xs text-slate-400" role="status">
            {label()}
          </p>
        )}
      </Show>
      <Show
        fallback={
          <Show when={state().freshness !== "loading"}>
            <p class="mt-4 rounded-xl border border-dashed border-white/10 p-3 text-xs leading-5 text-slate-500">
              No running or queued sessions.
            </p>
          </Show>
        }
        when={overview().visibleSessions.length > 0}
      >
        <ul class="mt-4 space-y-2">
          <For each={overview().visibleSessions}>
            {(session) => (
              <RunningSessionItem
                selectSession={props.selectSession}
                runnerName={runnerName(session.runnerId)}
                session={session}
              />
            )}
          </For>
        </ul>
      </Show>
      <Show when={overview().overflowCount > 0}>
        <button
          aria-label={`Show ${String(overview().overflowCount)} more active sessions in the session list`}
          class="mt-3 w-full rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          data-active-sessions-more="true"
          onClick={props.focusSessionList}
          type="button"
        >
          {`+${String(overview().overflowCount)} more`}
        </button>
      </Show>
    </>
  );
}

export function RunningSessionsPanel(
  props: RunningSessionsPanelProps,
): JSX.Element {
  const views = runningSessionsView(props.controller);
  const state = views.state;
  const overview = views.overview;

  return (
    <>
      <button
        aria-label={
          state().freshness === "loading"
            ? "Loading active sessions. Focus the session list."
            : `${countLabel(overview().runningCount, "Running")}; ${countLabel(overview().queuedCount, "Queued")}. Focus the session list.`
        }
        class="fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-slate-950/95 px-3 py-2 text-xs font-semibold text-white shadow-xl shadow-black/40 backdrop-blur sm:right-6 sm:bottom-6 md:px-4 lg:hidden"
        data-running-sessions-badge="true"
        onClick={props.focusSessionList}
        type="button"
      >
        <span aria-hidden="true" class="size-2 rounded-full bg-emerald-300" />
        <Show fallback="Loading…" when={state().freshness !== "loading"}>
          {countLabel(overview().runningCount, "Running")}
          <span class="text-slate-500">·</span>
          {countLabel(overview().queuedCount, "Queued")}
        </Show>
      </button>
      <aside
        aria-labelledby="running-sessions-title"
        class="hidden rounded-2xl border border-white/10 bg-slate-900/90 p-4 shadow-xl shadow-black/20 backdrop-blur lg:block xl:sticky xl:top-6 2xl:p-5"
        data-running-sessions-panel="true"
        {...renderDebugBoundary(
          "running-sessions-panel",
          "Running sessions panel",
        )}
      >
        <RunningSessionsContent {...props} />
      </aside>
    </>
  );
}
