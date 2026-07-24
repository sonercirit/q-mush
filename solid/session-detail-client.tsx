import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { reasoningEffortLabel } from "../shared/agent-configuration.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { Collection } from "./collection.tsx";
import { findById } from "./id-selection.ts";
import { SessionFollowUp } from "./session-client-forms.tsx";
import type { SessionViewState } from "./session-client.tsx";
import {
  CompactionControls,
  sessionContextClasses,
  sessionContextLabel,
} from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";
import type {
  LoadedSessionDetailViewProps,
  SessionDetailViewProps,
} from "./session-detail-view-props.ts";
import { RunnerReassignment } from "./session-reassignment-view.tsx";
import { SessionTranscriptFilterControls } from "./session-transcript-filter-controls.tsx";
import {
  SessionTranscript,
  sessionTranscriptFilterCounts,
} from "./session-transcript.tsx";

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
  session: Pick<AgentSessionSummary, "runnerRequired" | "status">,
): JSX.Element {
  const presentation = session.runnerRequired
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
                    {sessionModelLabel(session)}
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

function scrollRevision(detail: AgentSessionDetail): string {
  const agentFileRevision =
    detail.agentFile === null
      ? "none"
      : `${detail.agentFile.name}:${String(detail.agentFile.content.length)}`;
  return `${agentFileRevision}:${String(detail.messages.length)}:${detail.messages.at(-1)?.id ?? ""}`;
}

const SCROLL_END_TOLERANCE = 1;

function isAtScrollEnd(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.clientHeight - element.scrollTop <=
    SCROLL_END_TOLERANCE
  );
}

function composerUnavailableReason(
  detail: AgentSessionDetail,
  state: SessionViewState,
  runnerAvailable: boolean | undefined,
  credentialAvailable: boolean | undefined,
): string | undefined {
  if (state.loadingDetail) {
    return "Refreshing session state…";
  }
  if (state.sending) {
    return "Sending…";
  }
  if (state.stopping) {
    return "Stopping…";
  }
  if (state.compacting) {
    return "Compacting…";
  }
  if (state.reassigning) {
    return "Reassigning…";
  }
  if (detail.runnerRequired) {
    return "Choose a replacement runner before continuing this session.";
  }
  if (detail.status === "queued") {
    return "Session is queued. You can send when it is ready.";
  }
  if (detail.status === "running") {
    return "Session is running. You can send when it is ready.";
  }
  if (runnerAvailable === undefined) {
    return "Checking whether the session runner is available…";
  }
  if (credentialAvailable === undefined) {
    return "Checking whether the session credential is available…";
  }
  if (detail.status === "failed") {
    if (!runnerAvailable) {
      return "The failed session cannot resume because its runner is offline or unavailable.";
    }
    if (!credentialAvailable) {
      return "The failed session cannot resume because its credential is unavailable.";
    }
    return undefined;
  }
  if (detail.status === "stopped") {
    if (!runnerAvailable) {
      return "The stopped session cannot resume because its runner is offline or unavailable.";
    }
    if (!credentialAvailable) {
      return "The stopped session cannot resume because its credential is unavailable.";
    }
    return undefined;
  }
  if (!runnerAvailable) {
    return "The session runner is offline or unavailable.";
  }
  if (!credentialAvailable) {
    return "The session credential is unavailable.";
  }
  return undefined;
}

function LoadedSessionDetail(props: LoadedSessionDetailViewProps): JSX.Element {
  const active = (): boolean =>
    props.detail.status === "queued" || props.detail.status === "running";
  const composerReason = (): string | undefined =>
    composerUnavailableReason(
      props.detail,
      props.state,
      findById(props.runners, props.detail.runnerId) !== undefined,
      props.credentialAvailable,
    );
  const composerDisabled = (): boolean => composerReason() !== undefined;
  const compactionDisabled = (): boolean =>
    active() ||
    props.detail.runnerRequired ||
    props.state.compacting ||
    props.state.reassigning ||
    props.state.sending ||
    props.state.stopping;
  const [scrollLockEnabled, setScrollLockEnabled] = createSignal(true);
  const [transcript, setTranscript] = createSignal<HTMLUListElement>();
  const filterCounts = createMemo(() =>
    sessionTranscriptFilterCounts(
      props.detail.agentFile,
      props.detail.messages,
      props.detail.tools,
    ),
  );
  const scrollToEnd = (): void => {
    const element = transcript();
    if (scrollLockEnabled() && element !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  };
  const handleTranscriptScroll = (element: HTMLUListElement): void => {
    setScrollLockEnabled(isAtScrollEnd(element));
  };
  const toggleScrollLock = (): void => {
    const enabled = !scrollLockEnabled();
    setScrollLockEnabled(enabled);
    if (enabled) {
      scrollToEnd();
    }
  };

  onMount(scrollToEnd);
  createEffect(on(() => scrollRevision(props.detail), scrollToEnd));

  return (
    <div class="session-detail-view min-w-0" data-session-detail-view="true">
      <div class="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xl font-semibold text-white">
              {props.detail.title}
            </h3>
            {statusBadge(props.detail)}
          </div>
          <div class="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1 text-xs">
            <span class={sessionContextClasses(props.detail)}>
              {`${sessionModelLabel(props.detail)} · ${sessionContextLabel(props.detail)} ·`}
            </span>
            <code
              class="path-wrap min-w-0 text-cyan-200"
              data-working-directory="true"
            >
              {props.detail.workingDirectory}
            </code>
            <span class={sessionContextClasses(props.detail)}>
              {`· Agent file: ${props.detail.agentFile?.name ?? "None"}`}
            </span>
          </div>
          <span class="mt-2 block">
            <SessionMetrics session={props.detail} />
          </span>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button
            aria-pressed={scrollLockEnabled()}
            class={`rounded-full border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 ${scrollLockEnabled() ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-200" : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200"}`}
            data-scroll-lock-toggle="true"
            onClick={toggleScrollLock}
            type="button"
          >
            {`Scroll lock: ${scrollLockEnabled() ? "On" : "Off"}`}
          </button>
          <Show when={active()}>
            <button
              class="rounded-xl border border-rose-300/30 bg-rose-300/10 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-50"
              disabled={props.state.stopping}
              onClick={() => {
                void props.controller.stop();
              }}
              type="button"
            >
              {props.state.stopping ? "Stopping…" : "Stop session"}
            </button>
          </Show>
        </div>
      </div>
      <Show when={props.detail.runnerRequired}>
        <RunnerReassignment
          controller={props.controller}
          onOpenDirectoryPicker={props.onOpenDirectoryPicker}
          runners={props.runners}
          state={props.state}
        />
      </Show>
      <SessionTranscriptFilterControls
        counts={filterCounts()}
        filters={props.state.transcriptFilters}
        onChange={(name, visible) => {
          props.controller.setTranscriptFilter(name, visible);
        }}
      />
      <ul
        aria-live="polite"
        class="session-transcript mt-5 max-h-[36rem] min-w-0 space-y-3 overflow-y-auto overscroll-contain pr-1"
        data-session-transcript="true"
        onScroll={(event) => {
          handleTranscriptScroll(event.currentTarget);
        }}
        ref={setTranscript}
      >
        <SessionTranscript
          agentFile={props.detail.agentFile}
          filters={props.state.transcriptFilters}
          messages={props.detail.messages}
          tools={props.detail.tools}
        />
      </ul>
      <div class="session-composer mt-5 flex min-w-0 flex-col gap-3">
        <Show when={!active()}>
          <CompactionControls
            autoCompact={props.detail.autoCompact}
            compacting={props.state.compacting}
            disabled={compactionDisabled()}
            onCompact={() => {
              void props.controller.compact();
            }}
            onToggleAutoCompact={(enabled) => {
              void props.controller.toggleAutoCompact(enabled);
            }}
          />
        </Show>
        <div class="flex min-w-0 flex-col gap-3 sm:flex-row">
          <SessionFollowUp
            availabilityDescriptionId="session-composer-state"
            availabilityLabel={
              composerReason() ?? "Ready for another instruction."
            }
            disabled={composerDisabled()}
            images={props.state.followUpImages}
            onAddImages={(files) => {
              if (!composerDisabled()) {
                void props.controller.addImages(files, true);
              }
            }}
            onInput={(value) => {
              if (!composerDisabled()) {
                props.controller.setFollowUp(value);
              }
            }}
            onKeyDown={(event) => {
              if (
                !composerDisabled() &&
                event.ctrlKey &&
                event.key === "Enter"
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onRemoveImage={(index) => {
              if (!composerDisabled()) {
                props.controller.removeImage(index, "followUp");
              }
            }}
            onSubmit={() => {
              if (!composerDisabled()) {
                void props.controller.send();
              }
            }}
            prompt={props.state.followUp}
            sending={props.state.sending}
          />
          <Show when={!active()}>
            <button
              aria-describedby="session-composer-state"
              aria-label="Continue without another instruction"
              class="min-h-11 w-full self-stretch rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:self-end"
              disabled={composerDisabled()}
              onClick={() => {
                if (!composerDisabled()) {
                  void props.controller.continueSession();
                }
              }}
              type="button"
            >
              Continue without message
            </button>
          </Show>
        </div>
      </div>
    </div>
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
            controller={props.controller}
            credentialAvailable={props.credentialAvailable}
            detail={detail()}
            onOpenDirectoryPicker={props.onOpenDirectoryPicker}
            runners={props.runners}
            state={props.state}
          />
        )}
      </Show>
    </Show>
  );
}
