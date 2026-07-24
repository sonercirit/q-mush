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
import { SessionFollowUp } from "./session-client-forms.tsx";
import type { SessionViewState } from "./session-client.tsx";
import {
  CompactionControls,
  sessionContextClasses,
  sessionContextLabel,
} from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { SessionTranscript } from "./session-transcript.tsx";

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

function statusBadge(status: AgentSessionStatus): JSX.Element {
  const presentation = STATUS_PRESENTATION[status];
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

interface SessionViewProps {
  readonly controller: SessionController;
  readonly state: SessionViewState;
}

const SESSION_PAGE_SIZE = 10;

export function SessionList(props: {
  readonly controller: SessionController;
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
        listClass="max-h-144 space-y-2 overflow-y-auto"
        loading={<p class="text-sm text-slate-400">Loading sessions…</p>}
      >
        {(session) => (
          <li>
            <button
              class={`w-full rounded-2xl border p-4 text-left transition ${state().selectedId === session.id ? "border-emerald-300/30 bg-emerald-300/10" : "border-white/10 bg-slate-950/60 hover:border-white/20"}`}
              data-session-id={session.id}
              onClick={() => {
                void props.controller.select(session.id);
              }}
              type="button"
            >
              <span class="flex items-start justify-between gap-3">
                <span class="min-w-0">
                  <span class="block truncate font-semibold text-white">
                    {session.title}
                  </span>
                  <span class="mt-1 block truncate text-xs text-slate-500">
                    {sessionModelLabel(session)}
                  </span>
                  <span class="mt-2 block">
                    <SessionMetrics session={session} />
                  </span>
                </span>
                {statusBadge(session.status)}
              </span>
            </button>
          </li>
        )}
      </Collection>
      <Show when={(state().sessions?.length ?? 0) > SESSION_PAGE_SIZE}>
        <nav
          aria-label="Session list pagination"
          class="mt-3 flex items-center justify-between gap-3"
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

function PendingSessionInputs(props: {
  readonly inputs: AgentSessionDetail["pendingInputs"];
}): JSX.Element {
  return (
    <Show when={props.inputs.length > 0}>
      <section
        aria-label="Queued session input"
        class="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4"
      >
        <h4 class="text-sm font-semibold text-amber-200">Queued input</h4>
        <ul class="mt-3 space-y-2">
          {props.inputs.map((input) => (
            <li class="rounded-xl border border-white/10 bg-slate-950/70 p-3">
              <p class="text-xs font-semibold tracking-wide text-amber-200 uppercase">
                {input.kind === "steer" ? "Queued steer" : "Queued follow up"}
              </p>
              <Show when={input.content.length > 0}>
                <p class="mt-2 whitespace-pre-wrap text-sm text-slate-300">
                  {input.content}
                </p>
              </Show>
              <Show when={input.images.length > 0}>
                <p class="mt-2 text-xs text-slate-500">
                  {`${String(input.images.length)} attached image${input.images.length === 1 ? "" : "s"}`}
                </p>
              </Show>
            </li>
          ))}
        </ul>
      </section>
    </Show>
  );
}

function primaryShortcutLabel(platform: string): string {
  return /Mac|iPhone|iPad|iPod/u.test(platform) ? "⌘+Enter" : "Ctrl+Enter";
}

function LoadedSessionDetail(props: {
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
  readonly state: SessionViewState;
}): JSX.Element {
  const running = (): boolean => props.detail.status === "running";
  const queued = (): boolean => props.detail.status === "queued";
  const active = (): boolean => queued() || running();
  const [primaryShortcut, setPrimaryShortcut] = createSignal<{
    readonly keys: string;
    readonly label: string;
  }>({ keys: "Control+Enter", label: "Ctrl+Enter" });
  const [scrollLockEnabled, setScrollLockEnabled] = createSignal(true);
  const [transcript, setTranscript] = createSignal<HTMLUListElement>();
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

  onMount(() => {
    const label = primaryShortcutLabel(navigator.platform);
    setPrimaryShortcut({
      keys: label === "⌘+Enter" ? "Meta+Enter" : "Control+Enter",
      label,
    });
    scrollToEnd();
  });
  createEffect(on(() => scrollRevision(props.detail), scrollToEnd));

  return (
    <div>
      <div class="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xl font-semibold text-white">
              {props.detail.title}
            </h3>
            {statusBadge(props.detail.status)}
          </div>
          <p
            class={`mt-2 truncate text-xs ${sessionContextClasses(props.detail)}`}
          >
            {`${sessionModelLabel(props.detail)} · ${sessionContextLabel(props.detail)} · ${props.detail.workingDirectory} · Agent file: ${props.detail.agentFile?.name ?? "None"}`}
          </p>
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
      <ul
        aria-live="polite"
        class="mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1"
        data-session-transcript="true"
        onScroll={(event) => {
          handleTranscriptScroll(event.currentTarget);
        }}
        ref={setTranscript}
      >
        <SessionTranscript
          agentFile={props.detail.agentFile}
          messages={props.detail.messages}
          tools={props.detail.tools}
        />
      </ul>
      <PendingSessionInputs inputs={props.detail.pendingInputs} />
      <div class="mt-5 flex flex-col gap-3">
        <Show when={!active()}>
          <CompactionControls
            autoCompact={props.detail.autoCompact}
            compacting={props.state.compacting}
            onCompact={() => {
              void props.controller.compact();
            }}
            onToggleAutoCompact={(enabled) => {
              void props.controller.toggleAutoCompact(enabled);
            }}
          />
        </Show>
        {/* cpd-ignore-start -- Each action keeps its explicit controller operation and shortcut. */}
        <div class="flex gap-3">
          <SessionFollowUp
            actions={
              active()
                ? [
                    // cpd-ignore-start -- Action objects intentionally keep explicit controller operations.
                    {
                      label: "Follow up",
                      onClick: () => {
                        void props.controller.followUp();
                      },
                      shortcut: primaryShortcut().label,
                      shortcutKeys: primaryShortcut().keys,
                    },
                    {
                      disabled: queued(),
                      label: "Steer",
                      onClick: () => {
                        void props.controller.steer();
                      },
                      shortcut: "Shift+Enter",
                      shortcutKeys: "Shift+Enter",
                    },
                  ]
                : [
                    {
                      label: "Send",
                      onClick: () => {
                        void props.controller.send();
                      },
                      shortcut: primaryShortcut().label,
                      shortcutKeys: primaryShortcut().keys,
                    },
                    // cpd-ignore-end
                  ]
            }
            images={props.state.followUpImages}
            onAddImages={(files) => {
              void props.controller.addImages(files, true);
            }}
            onInput={(value) => {
              props.controller.setFollowUp(value);
            }}
            onKeyDown={(event) => {
              if (event.isComposing || event.key !== "Enter") {
                return;
              }
              if (event.shiftKey) {
                if (!queued()) {
                  event.preventDefault();
                  if (running()) {
                    void props.controller.steer();
                  } else {
                    void props.controller.continueSession();
                  }
                }
              } else if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                if (active()) {
                  void props.controller.followUp();
                } else {
                  void props.controller.send();
                }
              }
            }}
            onRemoveImage={(index) => {
              props.controller.removeImage(index, "followUp");
            }}
            prompt={props.state.followUp}
            sending={props.state.sending}
          />
          <Show when={!active()}>
            <button
              aria-keyshortcuts="Shift+Enter"
              class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950"
              disabled={props.state.sending}
              onClick={() => {
                void props.controller.continueSession();
              }}
              type="button"
            >
              Continue
              <kbd class="ml-2 text-xs font-normal opacity-70">Shift+Enter</kbd>
            </button>
          </Show>
        </div>
        {/* cpd-ignore-end */}
      </div>
    </div>
  );
}

export function SessionDetail(props: SessionViewProps): JSX.Element {
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
            detail={detail()}
            state={props.state}
          />
        )}
      </Show>
    </Show>
  );
}
