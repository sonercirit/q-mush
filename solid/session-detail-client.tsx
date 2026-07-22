import {
  createEffect,
  createSignal,
  on,
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

interface SessionViewProps {
  readonly controller: SessionController;
  readonly state: SessionViewState;
}

export function SessionList(props: {
  readonly controller: SessionController;
}): JSX.Element {
  const state = props.controller.view;
  return (
    <Collection
      empty={
        <p class="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
          No sessions yet. Start one above to give an agent a task.
        </p>
      }
      items={state().sessions}
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
              </span>
              {statusBadge(session.status)}
            </span>
          </button>
        </li>
      )}
    </Collection>
  );
}

function scrollRevision(detail: AgentSessionDetail): string {
  const agentFileRevision =
    detail.agentFile === null
      ? "none"
      : `${detail.agentFile.name}:${String(detail.agentFile.content.length)}`;
  return `${agentFileRevision}:${String(detail.messages.length)}:${detail.messages.at(-1)?.id ?? ""}`;
}

function LoadedSessionDetail(props: {
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
  readonly state: SessionViewState;
}): JSX.Element {
  const active = (): boolean =>
    props.detail.status === "queued" || props.detail.status === "running";
  const [transcript, setTranscript] = createSignal<HTMLUListElement>();
  const scrollToEnd = (): void => {
    const element = transcript();
    if (element !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  };

  onMount(scrollToEnd);
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
        </div>
        <Show when={active()}>
          <button
            class="shrink-0 rounded-xl border border-rose-300/30 bg-rose-300/10 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-50"
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
      <ul
        aria-live="polite"
        class="mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1"
        ref={setTranscript}
      >
        <SessionTranscript
          agentFile={props.detail.agentFile}
          messages={props.detail.messages}
        />
      </ul>
      <Show when={!active()}>
        <div class="mt-5 flex flex-col gap-3">
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
          <div class="flex gap-3">
            <SessionFollowUp
              images={props.state.followUpImages}
              onAddImages={(files) => {
                void props.controller.addImages(files, true);
              }}
              onInput={(value) => {
                props.controller.setFollowUp(value);
              }}
              onKeyDown={(event) => {
                if (event.ctrlKey && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onRemoveImage={(index) => {
                props.controller.removeImage(index, "followUp");
              }}
              onSubmit={() => {
                void props.controller.send();
              }}
              prompt={props.state.followUp}
              sending={props.state.sending}
            />
            <button
              class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950"
              disabled={props.state.sending}
              onClick={() => {
                void props.controller.continueSession();
              }}
              type="button"
            >
              Continue
            </button>
          </div>
        </div>
      </Show>
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
