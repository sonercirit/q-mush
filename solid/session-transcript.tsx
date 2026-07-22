import { type JSX } from "solid-js";
import type { AgentFile } from "../shared/agent-file.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import { AGENT_TOOLS } from "../shared/agent-tools.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { renderSessionImagePreviews } from "./session-image-client.tsx";
import { renderMarkdown } from "./session-markdown.tsx";
import { renderStructuredCode } from "./session-syntax.tsx";
import { renderToolResult } from "./session-tool-result.tsx";

const SERIALIZED_AGENT_TOOLS = JSON.stringify(AGENT_TOOLS, null, 2);

function renderTranscriptNote(options: {
  readonly boundaryKey: string;
  readonly classes: string;
  readonly content: string;
  readonly label: string;
  readonly labelClasses: string;
}): JSX.Element {
  return (
    <li
      class={`rounded-xl border p-4 ${options.classes}`}
      {...renderDebugBoundary(options.boundaryKey, options.label)}
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

function renderToolDefinitions(): JSX.Element {
  return (
    <li
      class="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-4"
      {...renderDebugBoundary("tool-definitions", "Tool definitions")}
    >
      <p class="text-xs font-semibold tracking-wide text-cyan-200 uppercase">
        Tool definitions
      </p>
      <div class="mt-3">{renderStructuredCode(SERIALIZED_AGENT_TOOLS)}</div>
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

function renderMessage(
  message: AgentSessionMessage,
  callArguments: ReadonlyMap<string, string>,
): JSX.Element {
  if (message.role === "thinking") {
    return renderTranscriptNote({
      boundaryKey: `message:${message.id}`,
      classes: "border-violet-300/20 bg-violet-300/10",
      content: message.content,
      label: "Thinking",
      labelClasses: "text-violet-200",
    });
  }

  if (message.role === "tool") {
    return (
      <li
        class="rounded-xl border border-white/10 bg-slate-950/80 p-4"
        {...renderDebugBoundary(`message:${message.id}`, "Tool result")}
      >
        {renderToolHeader({
          id: message.toolCallId,
          kind: "Tool result",
          name: message.toolName ?? "Unknown tool",
        })}
        <div class="mt-3">
          {renderToolResult({
            arguments:
              message.toolCallId === null
                ? undefined
                : callArguments.get(message.toolCallId),
            content: message.content,
            name: message.toolName ?? "Unknown tool",
          })}
        </div>
      </li>
    );
  }

  const user = message.role === "user";
  const system = message.role === "system";
  return (
    <li
      class={`rounded-2xl border p-4 ${user ? "ml-8 border-emerald-300/20 bg-emerald-300/10" : system ? "border-rose-300/20 bg-rose-300/10" : "mr-8 border-white/10 bg-white/[0.04]"}`}
      {...renderDebugBoundary(
        `message:${message.id}`,
        `${user ? "User" : system ? "Session" : "Agent"} message`,
      )}
    >
      <p class="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        {user ? "You" : system ? "Session" : "Agent"}
      </p>
      {message.content.length > 0 ? (
        user ? (
          <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
            {message.content}
          </p>
        ) : (
          <div class="mt-2">{renderMarkdown(message.content)}</div>
        )
      ) : null}
      {message.images.length > 0 ? (
        <div class="mt-3">{renderSessionImagePreviews(message.images)}</div>
      ) : null}
      {message.toolCalls.length > 0 ? (
        <ul class="mt-3 space-y-2">
          {message.toolCalls.map((call) => (
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

export function renderSessionTranscript(
  messages: readonly AgentSessionMessage[],
  agentFile: AgentFile | null,
): JSX.Element {
  const callArguments = toolCallArguments(messages);
  return [
    renderTranscriptNote({
      boundaryKey: "system-prompt",
      classes: "border-amber-300/20 bg-amber-300/10",
      content: createAgentSystemPrompt(agentFile),
      label: "System prompt",
      labelClasses: "text-amber-200",
    }),
    renderToolDefinitions(),
    ...messages.map((message) => renderMessage(message, callArguments)),
  ];
}
