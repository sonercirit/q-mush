import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { AskQuestionsForm } from "./ask-questions-client.tsx";
import { findById } from "./id-selection.ts";
import { SessionFollowUp } from "./session-client-forms.tsx";
import { sessionComposerUnavailableReason } from "./session-composer-availability.ts";
import {
  CompactionControls,
  sessionContextClasses,
} from "./session-context-client.tsx";
import type { LoadedSessionDetailViewProps } from "./session-detail-view-props.ts";
import { SessionHistoryControls } from "./session-history-client.tsx";
import {
  createSessionShortcuts,
  SessionPendingInputs,
} from "./session-pending-client.tsx";
import { RunnerReassignment } from "./session-reassignment-view.tsx";
import { SessionToolUpdateEditor } from "./session-tool-update-client.tsx";
import { SessionTranscriptFilterControls } from "./session-transcript-filter-controls.tsx";
import {
  SessionTranscript,
  sessionTranscriptFilterCounts,
} from "./session-transcript.tsx";

const SCROLL_END_TOLERANCE = 1;

function scrollRevision(
  detail: AgentSessionDetail,
  messages: AgentSessionDetail["messages"],
): string {
  const agentFileRevision =
    detail.agentFile === null
      ? "none"
      : `${detail.agentFile.name}:${String(detail.agentFile.content.length)}`;
  return `${agentFileRevision}:${String(messages.length)}:${messages.at(-1)?.id ?? ""}`;
}

function isAtScrollEnd(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.clientHeight - element.scrollTop <=
    SCROLL_END_TOLERANCE
  );
}

export function SessionDetailBody(props: {
  readonly contextLabel: string;
  readonly environmentLabel: string;
  readonly modelLabel: string;
  readonly presentation: JSX.Element;
  readonly sessionMetrics: JSX.Element;
  readonly view: LoadedSessionDetailViewProps;
}): JSX.Element {
  const { view } = props;
  const running = (): boolean => view.detail.status === "running";
  const queued = (): boolean => view.detail.status === "queued";
  const active = (): boolean =>
    queued() || running() || view.detail.status === "paused";
  const [, setShortcutPlatform] = createSessionShortcuts();
  const composerReason = (): string | undefined =>
    sessionComposerUnavailableReason(
      view.detail,
      view.state,
      findById(view.runners, view.detail.runnerId) !== undefined,
      view.credentialAvailable,
    );
  const composerDisabled = (): boolean => composerReason() !== undefined;
  const compactionDisabled = (): boolean =>
    active() ||
    view.detail.runnerRequired ||
    view.state.compacting ||
    view.state.reassigning ||
    view.state.sending ||
    view.state.stopping;
  const visibleMessages = (): AgentSessionDetail["messages"] =>
    view.state.history.page?.messages ?? view.detail.messages;
  const [scrollLockEnabled, setScrollLockEnabled] = createSignal(true);
  const [transcript, setTranscript] = createSignal<HTMLUListElement>();
  const filterCounts = createMemo(() =>
    sessionTranscriptFilterCounts(
      view.detail.agentFile,
      visibleMessages(),
      view.detail.tools,
    ),
  );
  const scrollToEnd = (): void => {
    const element = transcript();
    if (scrollLockEnabled() && element !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  };
  onMount(() => {
    scrollToEnd();
    setShortcutPlatform(navigator.platform);
  });
  createEffect(
    on(() => scrollRevision(view.detail, visibleMessages()), scrollToEnd),
  );

  return (
    <div class="session-detail-view min-w-0" data-session-detail-view="true">
      <div class="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xl font-semibold text-white">
              {view.detail.title}
            </h3>
            {props.presentation}
          </div>
          <div class="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1 text-xs">
            <span class={sessionContextClasses(view.detail)}>
              {`${props.modelLabel} · ${props.environmentLabel} · ${props.contextLabel} ·`}
            </span>
            <code
              class="path-wrap min-w-0 text-cyan-200"
              data-working-directory="true"
            >
              {view.detail.workingDirectory}
            </code>
            <span class={sessionContextClasses(view.detail)}>
              {`· Agent file: ${view.detail.agentFile?.name ?? "None"}`}
            </span>
          </div>
          <span class="mt-2 block">{props.sessionMetrics}</span>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button
            aria-pressed={scrollLockEnabled()}
            class={`rounded-full border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 ${scrollLockEnabled() ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-200" : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200"}`}
            data-scroll-lock-toggle="true"
            onClick={() => {
              const enabled = !scrollLockEnabled();
              setScrollLockEnabled(enabled);
              if (enabled) scrollToEnd();
            }}
            type="button"
          >
            {`Scroll lock: ${scrollLockEnabled() ? "On" : "Off"}`}
          </button>
          <Show when={active()}>
            <button
              class="rounded-xl border border-rose-300/30 bg-rose-300/10 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-50"
              disabled={view.state.stopping}
              onClick={() => void view.controller.stop()}
              type="button"
            >
              {view.state.stopping ? "Stopping…" : "Stop session"}
            </button>
          </Show>
        </div>
      </div>
      <Show when={view.detail.runnerRequired}>
        <RunnerReassignment {...view} />
      </Show>
      <SessionToolUpdateEditor
        detail={view.detail}
        disabled={view.state.updatingTools}
        onApply={(tools, confirmedCacheDrop) => {
          return view.controller.updateTools(tools, confirmedCacheDrop);
        }}
      />
      <SessionHistoryControls controller={view.controller} />
      <SessionTranscriptFilterControls
        counts={filterCounts()}
        filters={view.state.transcriptFilters}
        onChange={(name, visible) => {
          view.controller.setTranscriptFilter(name, visible);
        }}
      />
      <ul
        aria-live="polite"
        class="session-transcript mt-5 max-h-[36rem] min-w-0 space-y-3 overflow-y-auto overscroll-contain pr-1"
        data-session-transcript="true"
        onScroll={(event) =>
          setScrollLockEnabled(isAtScrollEnd(event.currentTarget))
        }
        ref={setTranscript}
      >
        <SessionTranscript
          agentFile={view.detail.agentFile}
          executionEnvironment={view.detail.executionEnvironment}
          filters={view.state.transcriptFilters}
          messages={visibleMessages()}
          toolStreams={
            view.state.history.page === undefined ? view.state.toolStreams : []
          }
          tools={view.detail.tools}
        />
      </ul>
      <SessionPendingInputs inputs={view.detail.pendingInputs} />
      <Show when={view.detail.pendingQuestions}>
        {(pending) => (
          <div class="mt-5">
            <AskQuestionsForm
              onSubmit={(answers) =>
                void view.controller.answerQuestions(answers)
              }
              pending={pending()}
              submitting={view.state.answeringQuestions}
            />
          </div>
        )}
      </Show>
      <div class="session-composer mt-5 flex min-w-0 flex-col gap-3">
        <Show when={!active()}>
          <CompactionControls
            autoCompact={view.detail.autoCompact}
            compacting={view.state.compacting}
            disabled={compactionDisabled()}
            onCompact={() => void view.controller.compact()}
            onToggleAutoCompact={(enabled) =>
              void view.controller.toggleAutoCompact(enabled)
            }
          />
        </Show>
        <SessionFollowUp
          availabilityDescriptionId="session-composer-state"
          availabilityLabel={
            composerReason() ??
            (running()
              ? "Running. Follow up starts the next turn; Steer changes direction at the next safe model or tool boundary."
              : queued()
                ? "Queued. Follow up starts after the queued work; steering is available only while running."
                : "Ready for another instruction.")
          }
          disabled={composerDisabled()}
          images={view.state.followUpImages}
          onAddImages={(files) => {
            if (!composerDisabled())
              void view.controller.addImages(files, true);
          }}
          onContinue={
            active()
              ? undefined
              : () => {
                  if (!composerDisabled())
                    void view.controller.continueSession();
                }
          }
          onInput={(value) => {
            if (!composerDisabled()) view.controller.setFollowUp(value);
          }}
          onKeyDown={(event) => {
            if (
              composerDisabled() ||
              event.isComposing ||
              event.key !== "Enter" ||
              (!event.ctrlKey && !event.metaKey)
            )
              return;
            event.preventDefault();
            if (event.shiftKey) {
              if (running()) void view.controller.steer();
            } else if (running() || queued()) {
              void view.controller.followUp();
            } else {
              event.currentTarget.form?.requestSubmit();
            }
          }}
          onRemoveImage={(index) => {
            if (!composerDisabled())
              view.controller.removeImage(index, "followUp");
          }}
          onSteer={
            running()
              ? () => {
                  if (!composerDisabled()) void view.controller.steer();
                }
              : undefined
          }
          onSubmit={() => {
            if (composerDisabled()) return;
            if (running() || queued()) void view.controller.followUp();
            else void view.controller.send();
          }}
          prompt={view.state.followUp}
          sending={view.state.sending}
          sessionId={view.detail.id}
          submitLabel={running() || queued() ? "Follow up" : "Send"}
        />
      </div>
    </div>
  );
}
