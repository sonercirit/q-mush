import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { AskQuestionsForm } from "./ask-questions-client.tsx";
import { clipboardCopyLabel, createClipboardCopy } from "./clipboard-copy.ts";
import { findById } from "./id-selection.ts";
import { createNestedScrollRef } from "./nested-scroll.ts";
import { SessionFollowUp } from "./session-client-forms.tsx";
import { SessionCompactionToggle } from "./session-compaction-toggle.tsx";
import { sessionComposerUnavailableReason } from "./session-composer-availability.ts";
import {
  CompactionControls,
  sessionContextClasses,
} from "./session-context-client.tsx";
import { SessionContextTokenCapEditor } from "./session-context-token-cap-editor.tsx";
import type { LoadedSessionDetailViewProps } from "./session-detail-view-props.ts";
import { SessionEditorGroup } from "./session-editor-group.tsx";
import { SessionForkEditor } from "./session-fork-client.tsx";
import { SessionHistoryControls } from "./session-history-client.tsx";
import {
  createSessionShortcuts,
  sessionComposerShortcut,
  SessionPendingInputs,
} from "./session-pending-client.tsx";
import { reconcilePendingInputs } from "./session-pending-input.ts";
import { sessionMutationPending } from "./session-pending.ts";
import { SessionProviderUpdateEditor } from "./session-provider-update-client.tsx";
import type { SessionProviderUpdateView } from "./session-provider-update-model.ts";
import { RunnerReassignment } from "./session-reassignment-view.tsx";
import { SessionStopDialog } from "./session-stop-dialog.tsx";
import { SessionToolUpdateEditor } from "./session-tool-update-client.tsx";
import { createSessionTranscriptCounts } from "./session-transcript-counts.ts";
import { SessionTranscriptFilterControls } from "./session-transcript-filter-controls.tsx";
import { SessionTranscript } from "./session-transcript.tsx";
import { SessionUsage } from "./session-usage-view.tsx";

const SCROLL_END_TOLERANCE = 64;

function currentPendingInputs(
  fallback: AgentSessionDetail,
  view: ReturnType<LoadedSessionDetailViewProps["controller"]["view"]>,
): ReturnType<typeof reconcilePendingInputs> {
  const detail = view.detail?.id === fallback.id ? view.detail : fallback;
  return reconcilePendingInputs(
    detail.pendingInputs,
    view.optimisticPendingInputs.filter(
      ({ sessionId }) => sessionId === detail.id,
    ),
  );
}

function sessionCopyText(detail: AgentSessionDetail): string {
  const transcript = detail.messages
    .filter(({ content }) => content.length > 0)
    .map(({ content, role }) => `${role}: ${content}`);
  return [
    detail.title,
    `Session ID: ${detail.id}`,
    `Status: ${detail.status}`,
    `Model: ${detail.provider} · ${detail.model}`,
    `Working directory: ${detail.workingDirectory}`,
    ...(transcript.length === 0 ? [] : ["", "Transcript", ...transcript]),
  ].join("\n");
}

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
  readonly providerUpdate: SessionProviderUpdateView;
  readonly sessionMetrics: JSX.Element;
  readonly view: LoadedSessionDetailViewProps;
}): JSX.Element {
  const view = (): LoadedSessionDetailViewProps => props.view;
  const nestedScrollRef = createNestedScrollRef(() => view().detail.id, true);
  const running = (): boolean => view().detail.status === "running";
  const queued = (): boolean => view().detail.status === "queued";
  const active = (): boolean =>
    queued() || running() || view().detail.status === "paused";
  const [shortcuts, setShortcutPlatform] = createSessionShortcuts();
  const composerReason = (): string | undefined =>
    sessionComposerUnavailableReason(
      view().detail,
      view().state,
      findById(view().runners, view().detail.runnerId) !== undefined,
      view().credentialAvailable,
    );
  const composerDisabled = (): boolean => composerReason() !== undefined;
  const sessionEditorDisabled = (): boolean =>
    active() || view().state.reassigning || view().state.updatingTools;
  const autoCompactionDisabled = (): boolean =>
    view().detail.runnerRequired || sessionMutationPending(view().state);
  const compactionDisabled = (): boolean =>
    active() || autoCompactionDisabled();
  const childCount = (): number =>
    view().state.sessions?.filter(
      ({ parentSessionId }) => parentSessionId === view().detail.id,
    ).length ?? 0;
  const [stopDialogChildCount, setStopDialogChildCount] =
    createSignal<number>();
  const [stopTrigger, setStopTrigger] = createSignal<HTMLElement>();
  const closeStopDialog = (): void => {
    setStopDialogChildCount(undefined);
  };
  const confirmStop = (cascade?: boolean): void => {
    closeStopDialog();
    if (cascade === undefined) void view().controller.stop();
    else void view().controller.stop(cascade);
  };
  const currentTranscript = (): boolean =>
    view().state.history.page === undefined;
  const visibleMessages = (): AgentSessionDetail["messages"] =>
    view().state.history.page?.messages ?? view().detail.messages;
  const sessionCopy = createClipboardCopy(() => sessionCopyText(view().detail));
  const [forkPointMessageId, setForkPointMessageId] = createSignal<string>();
  const [scrollLockEnabled, setScrollLockEnabled] = createSignal(true);
  const [transcript, setTranscript] = createSignal<HTMLUListElement>();
  let pendingScrollFrame: number | undefined;
  let programmaticScrollTop: number | undefined;
  let shouldScrollToEnd = true;
  const transcriptCounts = createSessionTranscriptCounts(
    () => view().detail.agentFile,
    visibleMessages,
    () => view().detail.tools,
  );
  const scrollToEnd = (): void => {
    shouldScrollToEnd = scrollLockEnabled();
    const element = transcript();
    if (!shouldScrollToEnd || element === undefined) return;
    if (pendingScrollFrame !== undefined) {
      window.cancelAnimationFrame(pendingScrollFrame);
    }
    pendingScrollFrame = window.requestAnimationFrame(() => {
      pendingScrollFrame = undefined;
      if (shouldScrollToEnd) {
        element.scrollTop = element.scrollHeight;
        programmaticScrollTop = element.scrollTop;
      }
    });
  };
  onCleanup(() => {
    if (pendingScrollFrame !== undefined) {
      window.cancelAnimationFrame(pendingScrollFrame);
    }
  });
  onMount(() => {
    scrollToEnd();
    setShortcutPlatform(navigator.platform);
  });
  createEffect(
    on(() => scrollRevision(view().detail, visibleMessages()), scrollToEnd),
  );

  return (
    <div
      class="session-detail-view min-w-0 [overflow-anchor:none]"
      data-session-detail-view="true"
      ref={nestedScrollRef}
    >
      <div class="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xl font-semibold text-white">
              {view().detail.title}
            </h3>
            {props.presentation}
          </div>
          <div class="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1 text-xs">
            <span class={sessionContextClasses(view().detail)}>
              {`${props.modelLabel} · ${props.environmentLabel} · ${props.contextLabel} ·`}
            </span>
            <code
              class="path-wrap min-w-0 text-cyan-200"
              data-working-directory="true"
            >
              {view().detail.workingDirectory}
            </code>
            <span class={sessionContextClasses(view().detail)}>
              {`· Agent file: ${view().detail.agentFile?.name ?? "None"}`}
            </span>
          </div>
          <span class="mt-2 block">{props.sessionMetrics}</span>
          <SessionUsage kind="session" usage={view().detail.tokenUsage} />
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button
            aria-live="polite"
            class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            data-copy-session="true"
            onClick={() => void sessionCopy.copy()}
            type="button"
          >
            {clipboardCopyLabel(sessionCopy.state(), "Copy session")}
          </button>
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
              disabled={view().state.stopping}
              onClick={(event) => {
                setStopTrigger(event.currentTarget);
                setStopDialogChildCount(childCount());
              }}
              type="button"
            >
              {view().state.stopping ? "Stopping…" : "Stop session"}
            </button>
          </Show>
        </div>
      </div>
      <SessionStopDialog
        childCount={stopDialogChildCount()}
        onCancel={closeStopDialog}
        onDecision={confirmStop}
        returnFocus={stopTrigger}
        variant="stop"
      />
      <Show when={view().detail.runnerRequired}>
        <RunnerReassignment {...view()} />
      </Show>
      <SessionEditorGroup
        provider={
          <SessionProviderUpdateEditor
            credentials={props.providerUpdate.credentials}
            detail={view().detail}
            disabled={sessionEditorDisabled()}
            onApply={props.providerUpdate.onApply}
            onDiscoverModels={props.providerUpdate.onDiscoverModels}
            onDiscoverProviders={props.providerUpdate.onDiscoverProviders}
          />
        }
        cap={
          <SessionContextTokenCapEditor
            detail={view().detail}
            disabled={
              sessionEditorDisabled() || sessionMutationPending(view().state)
            }
            onApply={(cap, compactIfExceeded) =>
              view().controller.setContextTokenCap(cap, compactIfExceeded)
            }
          />
        }
        tools={
          <SessionToolUpdateEditor
            detail={view().detail}
            disabled={view().state.updatingTools}
            onApply={(tools, confirmedCacheDrop) =>
              view().controller.updateTools(tools, confirmedCacheDrop)
            }
          />
        }
      />
      <SessionHistoryControls
        controller={view().controller}
        tokenUsage={
          view().state.history.page?.tokenUsage ??
          (view().state.history.page === undefined
            ? view().detail.segmentTokenUsage
            : undefined)
        }
      />
      <SessionTranscriptFilterControls
        counts={transcriptCounts().filterCounts}
        filters={view().state.transcriptFilters}
        onChange={(name, visible) => {
          view().controller.setTranscriptFilter(name, visible);
        }}
      />
      <ul
        aria-live="polite"
        class="session-transcript mt-5 flex max-h-[36rem] min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain pr-1"
        data-session-transcript="true"
        onScroll={(event) => {
          const element = event.currentTarget;
          const programmatic = element.scrollTop === programmaticScrollTop;
          programmaticScrollTop = undefined;
          // A scroll from our last write can arrive after streamed layout grows.
          // Preserve the lock for that event; user scrolling still uses proximity.
          const locked = programmatic
            ? scrollLockEnabled()
            : isAtScrollEnd(element);
          shouldScrollToEnd = locked;
          setScrollLockEnabled(locked);
        }}
        ref={setTranscript}
      >
        <SessionTranscript
          agentFile={view().detail.agentFile}
          counts={transcriptCounts()}
          executionEnvironment={view().detail.executionEnvironment}
          filters={view().state.transcriptFilters}
          messages={visibleMessages()}
          status={currentTranscript() ? view().detail.status : "idle"}
          onFork={
            view().state.history.page === undefined
              ? setForkPointMessageId
              : undefined
          }
          toolStreams={
            view().state.history.page === undefined
              ? view().state.toolStreams
              : []
          }
          tools={view().detail.tools}
          turns={currentTranscript() ? view().detail.turns : undefined}
        />
      </ul>
      <Show when={forkPointMessageId()}>
        {(messageId) => (
          <SessionForkEditor
            credentials={view().credentials}
            detail={view().detail}
            messageId={messageId()}
            onCancel={() => {
              setForkPointMessageId(undefined);
            }}
            onDiscoverModels={props.providerUpdate.onDiscoverModels}
            onFork={(forkMessageId, selection) =>
              view().controller.fork(forkMessageId, selection)
            }
          />
        )}
      </Show>
      <SessionPendingInputs
        inputs={currentPendingInputs(view().detail, view().controller.view())}
        onCancel={(inputId) => {
          void view().controller.cancelPendingInput(inputId);
        }}
        onRetry={(clientRequestId) => {
          void view().controller.retryPendingInput(clientRequestId);
        }}
      />
      <Show when={view().detail.pendingQuestions}>
        {(pending) => (
          <div class="mt-5">
            <AskQuestionsForm
              onSubmit={(answers) =>
                void view().controller.answerQuestions(answers)
              }
              pending={pending()}
              submitting={view().state.answeringQuestions}
            />
          </div>
        )}
      </Show>
      <div class="session-composer mt-5 flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <SessionCompactionToggle
            checked={view().detail.autoCompact}
            disabled={autoCompactionDisabled()}
            flag="autoCompact"
            onChange={(enabled) =>
              void view().controller.toggleCompactionFlag(
                "autoCompact",
                enabled,
              )
            }
          />
          <SessionCompactionToggle
            checked={view().detail.idleCompact}
            disabled={autoCompactionDisabled()}
            flag="idleCompact"
            onChange={(enabled) =>
              void view().controller.toggleCompactionFlag(
                "idleCompact",
                enabled,
              )
            }
          />
          <Show when={!active()}>
            <CompactionControls
              compacting={view().state.compacting}
              continueAvailable={view().detail.status === "idle"}
              disabled={compactionDisabled()}
              onCompact={(continueAfter) =>
                void view().controller.compact(continueAfter)
              }
            />
          </Show>
        </div>
        <SessionFollowUp
          availabilityDescriptionId="session-composer-state"
          availabilityLabel={
            composerReason() ??
            (running()
              ? "Running. Follow up starts the next turn; Steer is injected at the next step boundary, after the current model call and its tools settle."
              : queued()
                ? "Queued. Follow up starts after the queued work; steering is available only while running."
                : "Ready for another instruction.")
          }
          disabled={composerDisabled()}
          images={view().state.followUpImages}
          onAddImages={(files) => {
            if (!composerDisabled())
              void view().controller.addImages(files, true);
          }}
          onContinue={
            active()
              ? undefined
              : () => {
                  if (!composerDisabled())
                    void view().controller.continueSession();
                }
          }
          onInput={(value) => {
            if (!composerDisabled()) view().controller.setFollowUp(value);
          }}
          onKeyDown={(event) => {
            if (composerDisabled()) return;
            const shortcut = sessionComposerShortcut(event);
            if (
              shortcut !== undefined &&
              (shortcut === "follow_up" ? active() : !active())
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            } else if (shortcut === "follow_up" && !active()) {
              event.preventDefault();
              void view().controller.continueSession();
            } else if (shortcut === "steer" && running()) {
              event.preventDefault();
              void view().controller.steer();
            }
          }}
          onRemoveImage={(index) => {
            if (!composerDisabled())
              view().controller.removeImage(index, "followUp");
          }}
          onSteer={
            running()
              ? () => {
                  if (!composerDisabled()) void view().controller.steer();
                }
              : undefined
          }
          onSubmit={() => {
            if (composerDisabled()) return;
            if (running() || queued()) void view().controller.followUp();
            else void view().controller.send();
          }}
          prompt={view().state.followUp}
          sending={view().state.sending}
          sessionId={view().detail.id}
          shortcuts={shortcuts()}
          submitLabel={running() || queued() ? "Follow up" : "Send"}
          submitShortcut={active() ? "follow_up" : "steer"}
        />
      </div>
    </div>
  );
}
