import { For, type Accessor, type JSX } from "solid-js";
import type { AgentFile } from "../shared/agent-file.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  selectedAgentTools,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import { SessionImagePreviews } from "./session-image-client.tsx";
import { renderMarkdown } from "./session-markdown.tsx";
import { renderStructuredCode } from "./session-syntax.tsx";
import { renderToolResult } from "./session-tool-result.tsx";

function renderTranscriptNote(options: {
  readonly classes: string;
  readonly content: string;
  readonly label: string;
  readonly labelClasses: string;
  readonly messageId?: string;
}): JSX.Element {
  return (
    <li
      class={`rounded-xl border p-4 ${options.classes}`}
      data-session-message-id={options.messageId}
    >
      <p
        class={`text-xs font-semibold tracking-wide uppercase ${options.labelClasses}`}
      >
        {options.label}
      </p>
      <div class="mt-2">{renderMarkdown(options.content)}</div>
    </li>
  );
}

function renderToolDefinitions(serializedTools: string): JSX.Element {
  return (
    <li class="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-4">
      <p class="text-xs font-semibold tracking-wide text-cyan-200 uppercase">
        Tool definitions
      </p>
      <div class="mt-3">{renderStructuredCode(serializedTools)}</div>
    </li>
  );
}

function renderToolHeader(options: {
  readonly id: string | null;
  readonly kind: "Tool call" | "Tool result";
  readonly name: string;
}): JSX.Element {
  return (
    <div class="flex flex-wrap items-center justify-between gap-2">
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

function TranscriptMessage(props: {
  readonly callArguments: Accessor<ReadonlyMap<string, string>>;
  readonly message: AgentSessionMessage;
}): JSX.Element {
  if (props.message.role === "error" || props.message.role === "thinking") {
    const thinking = props.message.role === "thinking";
    return renderTranscriptNote({
      classes: thinking
        ? "border-violet-300/20 bg-violet-300/10"
        : "border-rose-300/20 bg-rose-300/10",
      content: props.message.content,
      label: thinking ? "Thinking" : "Error message",
      labelClasses: thinking ? "text-violet-200" : "text-rose-200",
      messageId: props.message.id,
    });
  }

  if (props.message.role === "tool") {
    return (
      <li
        class="rounded-xl border border-white/10 bg-slate-950/80 p-4"
        data-session-message-id={props.message.id}
      >
        {renderToolHeader({
          id: props.message.toolCallId,
          kind: "Tool result",
          name: props.message.toolName ?? "Unknown tool",
        })}
        <div class="mt-3">
          {renderToolResult({
            arguments:
              props.message.toolCallId === null
                ? undefined
                : props.callArguments().get(props.message.toolCallId),
            content: props.message.content,
            name: props.message.toolName ?? "Unknown tool",
          })}
        </div>
      </li>
    );
  }

  const user = props.message.role === "user";
  const system = props.message.role === "system";
  return (
    <li
      class={`rounded-2xl border p-4 ${user ? "ml-8 border-emerald-300/20 bg-emerald-300/10" : system ? "border-rose-300/20 bg-rose-300/10" : "mr-8 border-white/10 bg-white/[0.04]"}`}
      data-session-message-id={props.message.id}
    >
      <p class="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        {user ? "You" : system ? "Session" : "Agent"}
      </p>
      {props.message.content.length > 0 ? (
        user ? (
          <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
            {props.message.content}
          </p>
        ) : (
          <div class="mt-2">{renderMarkdown(props.message.content)}</div>
        )
      ) : null}
      {props.message.images.length > 0 ? (
        <div class="mt-3">
          <SessionImagePreviews images={props.message.images} />
        </div>
      ) : null}
      {props.message.toolCalls.length > 0 ? (
        <ul class="mt-3 space-y-2">
          {props.message.toolCalls.map((call) => (
            <li class="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3">
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

export function SessionTranscript(props: {
  readonly agentFile: AgentFile | null;
  readonly messages: readonly AgentSessionMessage[];
  readonly tools: readonly AgentSessionToolName[];
}): JSX.Element {
  const callArguments = (): ReadonlyMap<string, string> =>
    toolCallArguments(props.messages);
  const serializedTools = JSON.stringify(
    selectedAgentTools(props.tools),
    null,
    2,
  );
  return (
    <>
      {renderTranscriptNote({
        classes: "border-amber-300/20 bg-amber-300/10",
        content: createAgentSystemPrompt(props.agentFile),
        label: "System prompt",
        labelClasses: "text-amber-200",
      })}
      {renderToolDefinitions(serializedTools)}
      <For each={props.messages}>
        {(message) => (
          <TranscriptMessage callArguments={callArguments} message={message} />
        )}
      </For>
    </>
  );
}
