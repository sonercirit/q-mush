import { For, type Accessor, type JSX } from "solid-js";
import type { AgentFile } from "../shared/agent-file.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  selectedAgentTools,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import type {
  ToolStreamEntry,
  ToolStreamState,
} from "../shared/tool-stream.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { SessionImagePreviews } from "./session-image-client.tsx";
import { renderMarkdown } from "./session-markdown.tsx";
import { renderStructuredCode } from "./session-syntax.tsx";
import { renderToolResult } from "./session-tool-result.tsx";

function TranscriptNote(props: {
  readonly boundaryKey: string;
  readonly classes: string;
  readonly content: string;
  readonly label: string;
  readonly labelClasses: string;
}): JSX.Element {
  return (
    <li
      class={`rounded-xl border p-4 ${props.classes}`}
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

function renderToolDefinitions(serializedTools: string): JSX.Element {
  return (
    <li
      class="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-4"
      {...renderDebugBoundary("tool-definitions", "Tool definitions")}
    >
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
  if (props.message.role === "error") {
    return (
      <TranscriptNote
        boundaryKey={`message:${props.message.id}`}
        classes="border-rose-300/20 bg-rose-300/10"
        content={props.message.content}
        label="Error message"
        labelClasses="text-rose-200"
      />
    );
  }

  if (props.message.role === "thinking") {
    return (
      <TranscriptNote
        boundaryKey={`message:${props.message.id}`}
        classes="border-violet-300/20 bg-violet-300/10"
        content={props.message.content}
        label="Thinking"
        labelClasses="text-violet-200"
      />
    );
  }

  if (props.message.role === "tool") {
    return (
      <li
        class="rounded-xl border border-white/10 bg-slate-950/80 p-4"
        {...renderDebugBoundary(`message:${props.message.id}`, "Tool result")}
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
      {...renderDebugBoundary(
        `message:${props.message.id}`,
        `${user ? "User" : system ? "Session" : "Agent"} message`,
      )}
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

function toolStateLabel(state: ToolStreamState): string {
  switch (state) {
    case "preparing":
      return "Preparing";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "timed-out":
      return "Timed out";
  }
}

function renderLiveStream(
  stream: ToolStreamEntry,
  channel: "stderr" | "stdout",
): JSX.Element {
  const content = stream[channel];
  return content.length === 0 ? null : (
    <div class="mt-3">
      {renderToolResult({
        arguments: stream.arguments,
        content: `${channel}:\n${content}`,
        name: stream.name,
      })}
    </div>
  );
}

function LiveToolStream(props: {
  readonly stream: ToolStreamEntry;
}): JSX.Element {
  const name = (): string => props.stream.name || "Preparing tool";
  return (
    <li
      class="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-4"
      data-tool-stream-state={props.stream.state}
      {...renderDebugBoundary(
        `tool-stream:${props.stream.streamId}:${props.stream.callId}`,
        `Live tool: ${name()}`,
      )}
    >
      {renderToolHeader({
        id: props.stream.callId,
        kind: "Tool call",
        name: name(),
      })}
      <p class="mt-2 text-xs font-semibold text-amber-200">
        {toolStateLabel(props.stream.state)}
      </p>
      {props.stream.arguments.length === 0 ? null : (
        <div class="mt-2">{renderStructuredCode(props.stream.arguments)}</div>
      )}
      {renderLiveStream(props.stream, "stdout")}
      {renderLiveStream(props.stream, "stderr")}
    </li>
  );
}

export function SessionTranscript(props: {
  readonly agentFile: AgentFile | null;
  readonly messages: readonly AgentSessionMessage[];
  readonly toolStreams?: readonly ToolStreamEntry[];
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
      <TranscriptNote
        boundaryKey="system-prompt"
        classes="border-amber-300/20 bg-amber-300/10"
        content={createAgentSystemPrompt(props.agentFile)}
        label="System prompt"
        labelClasses="text-amber-200"
      />
      {renderToolDefinitions(serializedTools)}
      <For each={props.messages}>
        {(message) => (
          <TranscriptMessage callArguments={callArguments} message={message} />
        )}
      </For>
      <For each={props.toolStreams ?? []}>
        {(stream) => <LiveToolStream stream={stream} />}
      </For>
    </>
  );
}
