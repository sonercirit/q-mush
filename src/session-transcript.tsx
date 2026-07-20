import type { AgentFile } from "./agent-file.ts";
import { createAgentSystemPrompt } from "./agent-prompt.ts";
import { AGENT_TOOLS } from "./agent-tools.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import type { AgentSessionMessage } from "./session-model.ts";

const SERIALIZED_AGENT_TOOLS = JSON.stringify(AGENT_TOOLS, null, 2);

function renderTranscriptNote(options: {
  readonly classes: string;
  readonly content: string;
  readonly label: string;
  readonly labelClasses: string;
}): JsxNode {
  return (
    <li className={`rounded-xl border p-4 ${options.classes}`}>
      <p
        className={`text-xs font-semibold tracking-wide uppercase ${options.labelClasses}`}
      >
        {options.label}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
        {options.content}
      </p>
    </li>
  );
}

function renderToolDefinitions(): JsxNode {
  return (
    <li className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-4">
      <p className="text-xs font-semibold tracking-wide text-cyan-200 uppercase">
        Tool definitions
      </p>
      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">
        {SERIALIZED_AGENT_TOOLS}
      </pre>
    </li>
  );
}

function renderToolHeader(options: {
  readonly id: string | null;
  readonly kind: "Tool call" | "Tool result";
  readonly name: string;
}): JsxNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-semibold tracking-wide text-cyan-300 uppercase">
        {`${options.kind} · ${options.name}`}
      </p>
      {options.id === null ? null : (
        <code className="break-all text-[0.65rem] text-slate-500">
          {options.id}
        </code>
      )}
    </div>
  );
}

function renderMessage(message: AgentSessionMessage): JsxNode {
  if (message.role === "thinking") {
    return renderTranscriptNote({
      classes: "border-violet-300/20 bg-violet-300/10",
      content: message.content,
      label: "Thinking",
      labelClasses: "text-violet-200",
    });
  }

  if (message.role === "tool") {
    return (
      <li className="rounded-xl border border-white/10 bg-slate-950/80 p-4">
        {renderToolHeader({
          id: message.toolCallId,
          kind: "Tool result",
          name: message.toolName ?? "Unknown tool",
        })}
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">
          {message.content}
        </pre>
      </li>
    );
  }

  const user = message.role === "user";
  const system = message.role === "system";
  return (
    <li
      className={`rounded-2xl border p-4 ${user ? "ml-8 border-emerald-300/20 bg-emerald-300/10" : system ? "border-rose-300/20 bg-rose-300/10" : "mr-8 border-white/10 bg-white/[0.04]"}`}
    >
      <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        {user ? "You" : system ? "Session" : "Agent"}
      </p>
      {message.content.length > 0 ? (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
          {message.content}
        </p>
      ) : null}
      {message.toolCalls.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {message.toolCalls.map((call) => (
            <li className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3">
              {renderToolHeader({
                id: call.id,
                kind: "Tool call",
                name: call.name,
              })}
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">
                {call.arguments}
              </pre>
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
): JsxNode {
  return [
    renderTranscriptNote({
      classes: "border-amber-300/20 bg-amber-300/10",
      content: createAgentSystemPrompt(agentFile),
      label: "System prompt",
      labelClasses: "text-amber-200",
    }),
    renderToolDefinitions(),
    ...messages.map(renderMessage),
  ];
}
