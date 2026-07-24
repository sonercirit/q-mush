import { createMemo, For, Show, type Accessor, type JSX } from "solid-js";
import type { AgentFile } from "../shared/agent-file.ts";
import { AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt.ts";
import {
  selectedAgentTools,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { SessionImagePreviews } from "./session-image-client.tsx";
import { renderMarkdown } from "./session-markdown.tsx";
import { renderStructuredCode } from "./session-syntax.tsx";
import { renderToolResult } from "./session-tool-result.tsx";
import type {
  SessionTranscriptFilterName,
  SessionTranscriptFilters,
} from "./session-transcript-filters.ts";

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
        <div class="mt-3 max-h-80 overflow-auto">
          {renderStructuredCode(props.serializedTools)}
        </div>
      </details>
    </li>
  );
}

function renderToolHeader(options: {
  readonly id: string | null;
  readonly kind: "Tool call" | "Tool result";
  readonly name: string;
}): JSX.Element {
  return (
    <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <p class="text-xs font-semibold tracking-wide text-cyan-300 uppercase">
        {`${options.kind} · ${options.name}`}
      </p>
      {options.id === null ? null : (
        <code class="break-all text-[0.65rem] text-slate-500">
          {options.id}
        </code>
      )}
    </div>
  );
}

function toolCallArguments(
  messages: readonly AgentSessionMessage[],
): ReadonlyMap<string, string> {
  return new Map(
    messages.flatMap((message) =>
      message.toolCalls.map((call) => [call.id, call.arguments] as const),
    ),
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
  const error = props.kind === "error";
  return transcriptMessageNote({
    classes: error
      ? "border-rose-300/20 bg-rose-300/10"
      : "border-violet-300/20 bg-violet-300/10",
    label: error ? "Error message" : "Thinking",
    labelClasses: error ? "text-rose-200" : "text-violet-200",
    message: props.message,
  });
}

function messageToolName(message: AgentSessionMessage): string {
  return message.toolName ?? "Unknown tool";
}

interface TranscriptMessageProps {
  readonly callArguments: Accessor<ReadonlyMap<string, string>>;
  readonly message: AgentSessionMessage;
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

function ConversationTranscriptMessage(props: {
  readonly message: AgentSessionMessage;
  readonly showContent?: boolean;
  readonly showTools?: boolean;
}): JSX.Element {
  const user = props.message.role === "user";
  const system = props.message.role === "system";
  const showContent = (): boolean => props.showContent ?? true;
  const showTools = (): boolean => props.showTools ?? true;
  return (
    <li
      class={`min-w-0 rounded-2xl border p-3 sm:p-4 ${user ? "sm:ml-8 border-emerald-300/20 bg-emerald-300/10" : system ? "border-rose-300/20 bg-rose-300/10" : "sm:mr-8 border-white/10 bg-white/[0.04]"}`}
      {...renderDebugBoundary(
        `message:${props.message.id}`,
        `${user ? "User" : system ? "Session" : "Agent"} message`,
      )}
    >
      <p class="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        {user ? "You" : system ? "Session" : "Agent"}
      </p>
      {showContent() && props.message.content.length > 0 ? (
        user ? (
          <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
            {props.message.content}
          </p>
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
          {props.message.toolCalls.map((call) => (
            <li
              class="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3"
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
            </li>
          ))}
        </ul>
      ) : null}
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

export function sessionTranscriptFilterCounts(
  agentFile: AgentFile | null,
  messages: readonly AgentSessionMessage[],
  tools: readonly AgentSessionToolName[],
): Readonly<Record<SessionTranscriptFilterName, number>> {
  const counts: Record<SessionTranscriptFilterName, number> = {
    agentInstructions: agentFile === null ? 0 : 1,
    assistantMessages: 0,
    notices: 0,
    systemPrompt: 1,
    thinking: 0,
    toolActivity: 0,
    toolDefinitions: tools.length,
    userMessages: 0,
  };
  for (const message of messages) {
    switch (message.role) {
      case "error":
      case "system":
        counts.notices += 1;
        break;
      case "thinking":
        counts.thinking += 1;
        break;
      case "tool":
        counts.toolActivity += 1;
        break;
      case "user":
        counts.userMessages += 1;
        break;
      case "assistant":
        if (message.toolCalls.length > 0) {
          counts.toolActivity += message.toolCalls.length;
        }
        if (message.content.length > 0 || message.images.length > 0) {
          counts.assistantMessages += 1;
        }
        break;
    }
  }
  return counts;
}

function TranscriptMessage(
  props: TranscriptMessageProps & {
    readonly filters: SessionTranscriptFilters;
  },
): JSX.Element {
  const message = props.message;
  const callArguments = props.callArguments;
  if (message.role === "assistant") {
    return (
      <ConversationTranscriptMessage
        message={message}
        showContent={props.filters.assistantMessages}
        showTools={props.filters.toolActivity}
      />
    );
  }

  switch (message.role) {
    case "error":
      return <NoteTranscriptMessage kind="error" message={message} />;
    case "thinking":
      return <NoteTranscriptMessage kind="thinking" message={message} />;
    case "tool":
      return (
        <ToolResultTranscriptMessage
          callArguments={callArguments}
          message={message}
        />
      );
    case "system":
    case "user":
      return <ConversationTranscriptMessage message={message} />;
  }
}

export function SessionTranscript(props: {
  readonly agentFile: AgentFile | null;
  readonly filters: SessionTranscriptFilters;
  readonly messages: readonly AgentSessionMessage[];
  readonly tools: readonly AgentSessionToolName[];
}): JSX.Element {
  const callArguments = createMemo(() => toolCallArguments(props.messages));
  const serializedTools = createMemo(() =>
    JSON.stringify(selectedAgentTools(props.tools), null, 2),
  );
  const visibleMessages = createMemo(() =>
    props.messages.filter((message) =>
      messageIsVisible(message, props.filters),
    ),
  );
  const visibleItemCount = createMemo(() => {
    const counts = sessionTranscriptFilterCounts(
      props.agentFile,
      props.messages,
      props.tools,
    );
    return SESSION_TRANSCRIPT_FILTER_NAMES.reduce(
      (total, name) => total + (props.filters[name] ? counts[name] : 0),
      0,
    );
  });
  return (
    <>
      <Show when={props.filters.systemPrompt}>
        {renderTranscriptInstruction({
          boundaryKey: "system-prompt",
          content: AGENT_SYSTEM_PROMPT,
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
      <For each={visibleMessages()}>
        {(message) => (
          <TranscriptMessage
            callArguments={callArguments}
            filters={props.filters}
            message={message}
          />
        )}
      </For>
      <Show when={visibleItemCount() === 0}>
        <li class="rounded-xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
          No transcript items match the current visibility filters.
        </li>
      </Show>
    </>
  );
}
