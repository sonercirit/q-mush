import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { reasoningEffortLabel } from "../shared/agent-configuration.ts";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { Collection } from "./collection.tsx";
import { sessionContextLabel } from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { SessionDetailBody } from "./session-detail-body.tsx";
import type {
  LoadedSessionDetailViewProps,
  SessionDetailViewProps,
} from "./session-detail-view-props.ts";

const STATUS_PRESENTATION: Readonly<
  Record<
    AgentSessionStatus,
    { readonly classes: string; readonly label: string }
  >
> = {
  failed: {
    classes: "border-rose-300/20 bg-rose-300/10 text-rose-200",
    label: "Failed",
  },
  idle: {
    classes: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    label: "Ready",
  },
  paused: {
    classes: "border-violet-300/20 bg-violet-300/10 text-violet-200",
    label: "Restarting",
  },
  queued: {
    classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
    label: "Queued",
  },
  running: {
    classes: "border-emerald-300/20 bg-emerald-300/10 text-emerald-200",
    label: "Running",
  },
  stopped: {
    classes: "border-slate-400/20 bg-slate-400/10 text-slate-300",
    label: "Stopped",
  },
};

function statusBadge(
  session: Pick<
    AgentSessionSummary,
    "pendingQuestions" | "runnerRequired" | "status"
  >,
): JSX.Element {
  const presentation =
    session.pendingQuestions !== null
      ? {
          classes: "border-violet-300/20 bg-violet-300/10 text-violet-200",
          label: "Waiting for answers",
        }
      : session.runnerRequired
        ? {
            classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
            label: "Choose runner",
          }
        : STATUS_PRESENTATION[session.status];
  return (
    <span
      class={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      {presentation.label}
    </span>
  );
}

function executionEnvironmentLabel(
  environment: AgentSessionSummary["executionEnvironment"],
): string {
  return environment === "container" ? "Container" : "Bare Metal";
}

function sessionModelLabel(
  session: Pick<AgentSessionSummary, "model" | "provider" | "reasoningEffort">,
): string {
  const model = `${session.provider} · ${session.model}`;
  return session.reasoningEffort === null
    ? model
    : `${model} · ${reasoningEffortLabel(session.reasoningEffort)} reasoning`;
}

function formatSessionTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m`;
  }
  return minutes > 0
    ? `${String(minutes)}m ${String(remainingSeconds)}s`
    : `${String(remainingSeconds)}s`;
}

function formatSessionCost(costUsd: number): string {
  if (costUsd === 0) {
    return "$0.00";
  }
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function sessionCostText(
  session: Pick<AgentSessionSummary, "costBasis" | "costUsd">,
): string {
  switch (session.costBasis) {
    case "estimated":
      return `Estimated cost: ${formatSessionCost(session.costUsd)}`;
    case "none":
      return "Cost: Not available";
    case "reported":
      return `Cost: ${formatSessionCost(session.costUsd)}`;
  }
}

function SessionMetrics(props: {
  readonly session: Pick<
    AgentSessionSummary,
    "activeDurationMs" | "activeStartedAt" | "costBasis" | "costUsd"
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
    <span class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
      <span>
        {`Time: ${formatSessionTime(activeSessionDuration(props.session, now()))}`}
      </span>
      <span>{sessionCostText(props.session)}</span>
    </span>
  );
}

const SESSION_PAGE_SIZE = 10;

export function SessionList(props: {
  readonly controller: SessionController;
  readonly onSelect?: () => void;
}): JSX.Element {
  const state = props.controller.view;
  const [page, setPage] = createSignal(1);
  const pageCount = createMemo(() =>
    Math.max(1, Math.ceil((state().sessions?.length ?? 0) / SESSION_PAGE_SIZE)),
  );
  const sessions = createMemo(() => {
    const start = (page() - 1) * SESSION_PAGE_SIZE;
    return state().sessions?.slice(start, start + SESSION_PAGE_SIZE);
  });

  createEffect(() => {
    if (page() > pageCount()) {
      setPage(pageCount());
    }
  });

  return (
    <>
      <Collection
        empty={
          <p class="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
            No sessions yet. Start one above to give an agent a task.
          </p>
        }
        items={sessions()}
        listClass="session-list-items max-h-144 space-y-2 overflow-y-auto overscroll-contain pr-0.5"
        loading={<p class="text-sm text-slate-400">Loading sessions…</p>}
      >
        {(session) => (
          <li>
            <button
              aria-current={
                state().selectedId === session.id ? "true" : undefined
              }
              class={`session-list-item min-h-11 w-full rounded-2xl border p-3 text-left transition sm:p-4 ${state().selectedId === session.id ? "border-emerald-300/30 bg-emerald-300/10" : "border-white/10 bg-slate-950/60 hover:border-white/20"}`}
              data-session-id={session.id}
              onClick={() => {
                props.onSelect?.();
                void props.controller.select(session.id);
              }}
              type="button"
            >
              <span class="flex items-start justify-between gap-3">
                <span class="min-w-0 flex-1">
                  <span class="session-list-title block min-w-0 break-words font-semibold text-white">
                    {session.title}
                  </span>
                  <span class="session-list-meta mt-1 block min-w-0 break-words text-xs leading-5 text-slate-500">
                    {`${sessionModelLabel(session)} · ${executionEnvironmentLabel(session.executionEnvironment)}`}
                  </span>
                  <span class="mt-2 block">
                    <SessionMetrics session={session} />
                  </span>
                </span>
                {statusBadge(session)}
              </span>
            </button>
          </li>
        )}
      </Collection>
      <Show when={(state().sessions?.length ?? 0) > SESSION_PAGE_SIZE}>
        <nav
          aria-label="Session list pagination"
          class="session-list-pagination mt-3 flex flex-wrap items-center justify-between gap-2"
        >
          <button
            aria-label="Previous session page"
            class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={page() === 1}
            onClick={() => {
              setPage((current) => Math.max(1, current - 1));
            }}
            type="button"
          >
            Previous
          </button>
          <span class="text-xs text-slate-500">
            {`Page ${String(page())} of ${String(pageCount())}`}
          </span>
          <button
            aria-label="Next session page"
            class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={page() === pageCount()}
            onClick={() => {
              setPage((current) => Math.min(pageCount(), current + 1));
            }}
            type="button"
          >
            Next
          </button>
        </nav>
      </Show>
    </>
  );
}

function LoadedSessionDetail(props: LoadedSessionDetailViewProps): JSX.Element {
  return (
    <SessionDetailBody
      contextLabel={sessionContextLabel(props.detail)}
      environmentLabel={executionEnvironmentLabel(
        props.detail.executionEnvironment,
      )}
      modelLabel={sessionModelLabel(props.detail)}
      presentation={statusBadge(props.detail)}
      sessionMetrics={<SessionMetrics session={props.detail} />}
      view={props}
    />
  );
}

export function SessionDetail(props: SessionDetailViewProps): JSX.Element {
  return (
    <Show
      fallback={
        <div class="grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/15 text-sm text-slate-500">
          Select a session to view its transcript.
        </div>
      }
      when={props.state.selectedId}
    >
      <Show
        fallback={<p class="text-sm text-slate-400">Loading transcript…</p>}
        when={props.state.loadingDetail ? undefined : props.state.detail}
      >
        {(detail) => (
          <LoadedSessionDetail
            {...props}
            credentialAvailable={props.credentialAvailable}
            detail={detail()}
          />
        )}
      </Show>
    </Show>
  );
}
