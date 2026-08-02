import {
  createMemo,
  For,
  Show,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import type { AgentFile } from "../shared/agent-file.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  selectedAgentTools,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionStatus,
} from "../shared/session-model.ts";
import {
  activeSessionDuration,
  formatSessionTime,
} from "../shared/session-timing.ts";
import type { ToolStreamEntry } from "../shared/tool-stream.ts";
import { clipboardCopyLabel, createClipboardCopy } from "./clipboard-copy.ts";
import { createLiveNow } from "./live-now.ts";
import { createNestedScrollRef } from "./nested-scroll.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { ActiveStepAnchor } from "./session-active-step.tsx";
import { SessionImagePreviews } from "./session-image-client.tsx";
import {
  LiveToolActivityContent,
  LiveToolStream,
  renderToolHeader,
} from "./session-live-tool-activity.tsx";
import { renderMarkdown } from "./session-markdown.tsx";
import { createSessionStepTiming } from "./session-step-timing.ts";
import { renderStructuredText } from "./session-structured-text.tsx";
import { renderStructuredCode } from "./session-syntax.tsx";
import { renderToolResult } from "./session-tool-result.tsx";
import {
  createSessionTranscriptCounts,
  type SessionTranscriptCounts,
} from "./session-transcript-counts.ts";
import type {
  SessionTranscriptFilterName,
  SessionTranscriptFilters,
} from "./session-transcript-filters.ts";
import {
  createSessionTranscriptMessageGroups,
  transcriptMessageNestedScrollKey,
} from "./session-transcript-messages.ts";

function StepTiming(props: {
  readonly endedAt: number | null;
  readonly startedAt: number;
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
  return (
    <p
      class="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs text-slate-500"
      data-step-timing={props.endedAt === null ? "active" : "completed"}
    >
      <span>{`Duration: ${formatSessionTime(duration())}`}</span>
      <span>Started: {time(props.startedAt)}</span>
      <Show when={props.endedAt}>
        {(endedAt) => <span>Ended: {time(endedAt())}</span>}
      </Show>
    </p>
  );
}

function TranscriptNote(props: {
  readonly boundaryKey: string;
  readonly classes: string;
  readonly content: string;
  readonly label: string;
  readonly labelClasses: string;
}): JSX.Element {
  return (
    <li
      class={`min-w-0 rounded-xl border p-3 sm:p-4 ${props.classes}`}
      {...renderDebugBoundary(props.boundaryKey, props.label)}
    >
      <p
        class={`text-xs font-semibold tracking-wide uppercase ${props.labelClasses}`}
      >
        {props.label}
      </p>
      <div class="mt-2">{renderMarkdown(props.content)}</div>
    </li>
  );
}

function renderTranscriptInstruction(options: {
  readonly boundaryKey: string;
  readonly content: string;
  readonly label: string;
}): JSX.Element {
  return (
    <TranscriptNote
      boundaryKey={options.boundaryKey}
      classes="border-amber-300/20 bg-amber-300/10"
      content={options.content}
      label={options.label}
      labelClasses="text-amber-200"
    />
  );
}

function ToolDefinitions(props: {
  readonly serializedTools: string;
}): JSX.Element {
  return (
    <li
      class="min-w-0 rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-3 sm:p-4"
      {...renderDebugBoundary("tool-definitions", "Tool definitions")}
    >
      <p class="text-xs font-semibold tracking-wide text-cyan-200 uppercase">
        Tool definitions
      </p>
      <details class="mt-3">
        <summary class="cursor-pointer text-sm font-medium text-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300">
          Show selected tool schemas
        </summary>
        <div class="mt-3">{renderStructuredCode(props.serializedTools)}</div>
      </details>
    </li>
  );
}

function transcriptMessageNote(options: {
  readonly classes: string;
  readonly label: string;
  readonly labelClasses: string;
  readonly message: AgentSessionMessage;
}): JSX.Element {
  return (
    <TranscriptNote
      boundaryKey={`message:${options.message.id}`}
      classes={options.classes}
      content={options.message.content}
      label={options.label}
      labelClasses={options.labelClasses}
    />
  );
}

function NoteTranscriptMessage(props: {
  readonly kind: "error" | "thinking";
  readonly message: AgentSessionMessage;
}): JSX.Element {
  const error = (): boolean => props.kind === "error";
  return (
    <>
      {transcriptMessageNote({
        classes: error()
          ? "border-rose-300/20 bg-rose-300/10"
          : "border-violet-300/20 bg-violet-300/10",
        label: error() ? "Error message" : "Thinking",
        labelClasses: error() ? "text-rose-200" : "text-violet-200",
        message: props.message,
      })}
    </>
  );
}

function messageToolName(message: AgentSessionMessage): string {
  return message.toolName ?? "Unknown tool";
}

interface TranscriptMessageProps {
  readonly callArguments: Accessor<ReadonlyMap<string, string>>;
  readonly message: AgentSessionMessage;
}

function isStreamedMessage(message: AgentSessionMessage): boolean {
  return message.id.startsWith("stream:");
}

function ToolResultTranscriptMessage(
  props: TranscriptMessageProps,
): JSX.Element {
  return (
    <li
      class="min-w-0 rounded-xl border border-white/10 bg-slate-950/80 p-3 sm:p-4"
      {...renderDebugBoundary(`message:${props.message.id}`, "Tool result")}
    >
      {renderToolHeader({
        id: props.message.toolCallId,
        kind: "Tool result",
        name: messageToolName(props.message),
      })}
      <div class="mt-3">
        {renderToolResult({
          arguments:
            props.message.toolCallId === null
              ? undefined
              : props.callArguments().get(props.message.toolCallId),
          content: props.message.content,
          name: messageToolName(props.message),
        })}
      </div>
    </li>
  );
}

function MessageCopyButton(props: {
  readonly content: string;
  readonly messageId: string;
}): JSX.Element {
  const clipboard = createClipboardCopy(() => props.content);
  return (
    <button
      aria-live="polite"
      class="rounded-full border border-white/10 px-2.5 py-1 text-[0.65rem] font-semibold text-slate-400 transition hover:border-emerald-300/30 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
      data-copy-message={props.messageId}
      onClick={() => void clipboard.copy()}
      type="button"
    >
      {clipboardCopyLabel(clipboard.state(), "Copy")}
    </button>
  );
}

function ConversationTranscriptMessage(props: {
  readonly liveToolStreams?: readonly ToolStreamEntry[];
  readonly message: AgentSessionMessage;
  readonly onFork?: ((messageId: string) => void) | undefined;
  readonly showContent?: boolean;
  readonly showTools?: boolean;
  readonly toolStreams?: Accessor<ReadonlyMap<string, ToolStreamEntry>>;
}): JSX.Element {
  const user = (): boolean => props.message.role === "user";
  const system = (): boolean => props.message.role === "system";
  const showContent = (): boolean => props.showContent ?? true;
  const showTools = (): boolean => props.showTools ?? true;
  return (
    <li
      class={`min-w-0 rounded-2xl border p-3 sm:p-4 ${user() ? "sm:ml-8 border-emerald-300/20 bg-emerald-300/10" : system() ? "border-rose-300/20 bg-rose-300/10" : "sm:mr-8 border-white/10 bg-white/[0.04]"}`}
      {...renderDebugBoundary(
        `message:${props.message.id}`,
        `${user() ? "User" : system() ? "Session" : "Agent"} message`,
      )}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs font-semibold tracking-wide text-slate-400 uppercase">
          {user() ? "You" : system() ? "Session" : "Agent"}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          {!system() && showContent() && props.message.content.length > 0 ? (
            <MessageCopyButton
              content={props.message.content}
              messageId={props.message.id}
            />
          ) : null}
          {!system() &&
          props.onFork !== undefined &&
          !isStreamedMessage(props.message) ? (
            <button
              class="rounded-full border border-white/10 px-2.5 py-1 text-[0.65rem] font-semibold text-slate-400 transition hover:border-emerald-300/30 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              data-fork-from-here={props.message.id}
              onClick={() => props.onFork?.(props.message.id)}
              type="button"
            >
              Fork from here
            </button>
          ) : null}
        </div>
      </div>
      {showContent() && props.message.content.length > 0 ? (
        user() ? (
          renderStructuredText(props.message.content, (text) => (
            <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
              {text}
            </p>
          ))
        ) : (
          <div class="mt-2">{renderMarkdown(props.message.content)}</div>
        )
      ) : null}
      {showContent() && props.message.images.length > 0 ? (
        <div class="mt-3">
          <SessionImagePreviews images={props.message.images} />
        </div>
      ) : null}
      {showTools() && props.message.toolCalls.length > 0 ? (
        <ul class="mt-3 space-y-2">
          <For each={props.message.toolCalls}>
            {(call) => {
              const stream = () => props.toolStreams?.().get(call.id);
              return (
                <li
                  class="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3"
                  data-tool-stream-state={stream()?.state}
                  {...renderDebugBoundary(
                    `tool-call:${call.id}`,
                    `Tool call: ${call.name}`,
                  )}
                >
                  {renderToolHeader({
                    id: call.id,
                    kind: "Tool call",
                    name: call.name,
                  })}
                  <div class="mt-2">{renderStructuredCode(call.arguments)}</div>
                  <Show when={stream()}>
                    {(liveStream) => (
                      <LiveToolActivityContent
                        includeArguments={false}
                        stream={liveStream()}
                      />
                    )}
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      ) : null}
      <Show when={showTools() && (props.liveToolStreams?.length ?? 0) > 0}>
        <ul class="mt-3 space-y-2">
          <For each={props.liveToolStreams}>
            {(stream) => <LiveToolStream stream={stream} />}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function messageIsVisible(
  message: AgentSessionMessage,
  filters: SessionTranscriptFilters,
): boolean {
  switch (message.role) {
    case "error":
    case "system":
      return filters.notices;
    case "thinking":
      return filters.thinking;
    case "tool":
      return filters.toolActivity;
    case "user":
      return filters.userMessages;
    case "assistant":
      return (
        (filters.assistantMessages &&
          (message.content.length > 0 || message.images.length > 0)) ||
        (filters.toolActivity && message.toolCalls.length > 0)
      );
  }
}

const SESSION_TRANSCRIPT_FILTER_NAMES: readonly SessionTranscriptFilterName[] =
  [
    "agentInstructions",
    "assistantMessages",
    "notices",
    "systemPrompt",
    "thinking",
    "toolActivity",
    "toolDefinitions",
    "userMessages",
  ];

type TranscriptRenderableMessageProps = TranscriptMessageProps & {
  readonly filters: Readonly<SessionTranscriptFilters>;
  readonly liveToolStreams: readonly ToolStreamEntry[];
  readonly nestedScrollKey: string;
  readonly onForkMessage?: ((messageId: string) => void) | undefined;
  readonly streamEntries: () => ReadonlyMap<string, ToolStreamEntry>;
};

function renderTranscriptMessage(
  props: TranscriptRenderableMessageProps,
): JSX.Element {
  switch (untrack(() => props.message.role)) {
    case "assistant":
      return (
        <ConversationTranscriptMessage
          liveToolStreams={props.liveToolStreams}
          message={props.message}
          onFork={props.onForkMessage}
          showContent={props.filters.assistantMessages}
          showTools={props.filters.toolActivity}
          toolStreams={props.streamEntries}
        />
      );
    case "error":
      return <NoteTranscriptMessage kind="error" message={props.message} />;
    case "thinking":
      return <NoteTranscriptMessage kind="thinking" message={props.message} />;
    case "tool":
      return (
        <ToolResultTranscriptMessage
          callArguments={props.callArguments}
          message={props.message}
        />
      );
    case "system":
      return <ConversationTranscriptMessage message={props.message} />;
    case "user":
      return (
        <ConversationTranscriptMessage
          message={props.message}
          onFork={props.onForkMessage}
        />
      );
  }
}

function TranscriptMessage(
  props: TranscriptRenderableMessageProps,
): JSX.Element {
  const nestedScrollRef = createNestedScrollRef(() => props.nestedScrollKey);
  return (
    <li class="contents" ref={nestedScrollRef}>
      {renderTranscriptMessage(props)}
    </li>
  );
}

export function SessionTranscript(props: {
  readonly agentFile: AgentFile | null;
  readonly counts?: SessionTranscriptCounts | undefined;
  readonly executionEnvironment: AgentSessionDetail["executionEnvironment"];
  readonly filters: SessionTranscriptFilters;
  readonly messages: readonly AgentSessionMessage[];
  readonly onFork?: ((messageId: string) => void) | undefined;
  readonly status?: AgentSessionStatus | undefined;
  readonly toolStreams?: readonly ToolStreamEntry[];
  readonly tools: readonly AgentSessionToolName[];
  readonly turns?: AgentSessionDetail["turns"];
}): JSX.Element {
  const messageGroups = createSessionTranscriptMessageGroups(
    () => props.messages,
  );
  const localCounts = createSessionTranscriptCounts(
    () => props.agentFile,
    () => props.messages,
    () => props.tools,
  );
  const counts = (): SessionTranscriptCounts => props.counts ?? localCounts();
  const serializedTools = createMemo(() =>
    JSON.stringify(selectedAgentTools(props.tools), null, 2),
  );
  const stepTiming = createSessionStepTiming(
    () => props.messages,
    () => props.status ?? "idle",
    () => props.turns,
  );
  const visibleItemCount = createMemo(() => {
    const filterCounts = counts().filterCounts;
    let total = 0;
    for (const name of SESSION_TRANSCRIPT_FILTER_NAMES) {
      if (props.filters[name]) {
        total += filterCounts[name];
      }
    }
    return total;
  });
  const toolStreamsByCallId = createMemo<ReadonlyMap<string, ToolStreamEntry>>(
    () =>
      new Map(
        (props.toolStreams ?? []).map((stream) => [stream.callId, stream]),
      ),
  );
  const standaloneToolStreams = createMemo(() =>
    (props.toolStreams ?? []).filter(
      (stream) => !counts().toolCallArguments.has(stream.callId),
    ),
  );
  const activeMessages = createMemo(() =>
    standaloneToolStreams().length === 0
      ? messageGroups().streamed
      : messageGroups().streamed.filter((message) =>
          messageIsVisible(message, props.filters),
        ),
  );
  const renderMessageWithStreams = (
    message: AgentSessionMessage,
    liveToolStreams: readonly ToolStreamEntry[],
  ): JSX.Element => (
    <>
      <Show when={messageIsVisible(message, props.filters)}>
        <TranscriptMessage
          callArguments={() => counts().toolCallArguments}
          filters={props.filters}
          liveToolStreams={liveToolStreams}
          message={message}
          nestedScrollKey={transcriptMessageNestedScrollKey(
            props.messages,
            message,
          )}
          onForkMessage={props.onFork}
          streamEntries={toolStreamsByCallId}
        />
      </Show>
      <Show when={stepTiming().completedTimings.get(message.id)}>
        {(timing) => (
          <StepTiming
            endedAt={timing().endedAt}
            startedAt={timing().startedAt}
          />
        )}
      </Show>
    </>
  );
  const renderMessage = (message: AgentSessionMessage): JSX.Element =>
    renderMessageWithStreams(message, []);
  return (
    <>
      <Show when={props.filters.systemPrompt}>
        {renderTranscriptInstruction({
          boundaryKey: "system-prompt",
          content: createAgentSystemPrompt(null, props.executionEnvironment),
          label: "System prompt",
        })}
      </Show>
      <Show when={props.filters.agentInstructions && props.agentFile !== null}>
        {renderTranscriptInstruction({
          boundaryKey: "agent-instructions",
          content: props.agentFile?.content ?? "",
          label: props.agentFile?.name ?? "Agent instructions",
        })}
      </Show>
      <Show when={props.filters.toolDefinitions && props.tools.length > 0}>
        <ToolDefinitions serializedTools={serializedTools()} />
      </Show>
      <For each={messageGroups().stable}>{renderMessage}</For>
      <Show
        fallback={<For each={messageGroups().streamed}>{renderMessage}</For>}
        when={stepTiming().activeStartedAt}
        keyed
      >
        {(startedAt) => (
          <ActiveStepAnchor
            messages={activeMessages()}
            renderMessage={renderMessage}
            renderMessageWithToolStreams={renderMessageWithStreams}
            timing={<StepTiming endedAt={null} startedAt={startedAt} />}
            toolStreams={
              props.filters.toolActivity ? standaloneToolStreams() : []
            }
          />
        )}
      </Show>
      <Show when={visibleItemCount() === 0}>
        <li class="rounded-xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
          No transcript items match the current visibility filters.
        </li>
      </Show>
    </>
  );
}
