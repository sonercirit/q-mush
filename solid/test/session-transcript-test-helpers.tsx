import type { JSX } from "solid-js";
import type { AgentFile } from "../../shared/agent-file.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type {
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionTurn,
} from "../../shared/session-model.ts";
import type { ToolStreamEntry } from "../../shared/tool-stream.ts";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  type SessionTranscriptFilters,
} from "../../solid/session-transcript-filters.ts";
import { SessionTranscript } from "../../solid/session-transcript.tsx";
import { renderSolidToString } from "./render-solid.tsx";

interface TranscriptTestMessageOptions {
  readonly content: string;
  readonly id: string;
  readonly name: string;
}

const EMPTY_MESSAGE_METADATA = {
  images: [],
  toolCallId: null,
  toolCalls: [],
  toolName: null,
} as const;

function transcriptMessage(
  options: TranscriptTestMessageOptions,
  kind: "call" | "result",
): AgentSessionMessage {
  const call = kind === "call";
  return {
    content: call ? "" : options.content,
    createdAt: call ? 1 : 2,
    id: `${call ? "assistant" : "result"}-${options.id}`,
    images: [],
    role: call ? "assistant" : "tool",
    toolCallId: call ? null : options.id,
    toolCalls: call
      ? [{ arguments: options.content, id: options.id, name: options.name }]
      : [],
    toolName: call ? null : options.name,
  };
}

export function assistantToolCall(options: {
  readonly arguments: string;
  readonly id: string;
  readonly name: string;
}): AgentSessionMessage {
  return transcriptMessage(
    { content: options.arguments, id: options.id, name: options.name },
    "call",
  );
}

export function toolResult(
  options: TranscriptTestMessageOptions,
): AgentSessionMessage {
  return transcriptMessage(options, "result");
}

export function userMessage(content: string): AgentSessionMessage {
  const message_ = transcriptMessage(
    { content, id: "user-1", name: "unused" },
    "result",
  );
  return {
    ...message_,
    role: "user",
    toolCallId: null,
    toolName: null,
  };
}

export function renderMessages(
  messages: readonly AgentSessionMessage[],
  tools = AGENT_SESSION_TOOL_NAMES,
  filters: SessionTranscriptFilters = DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  agentFile: AgentFile | null = null,
  onFork?: (messageId: string) => void,
  turns?: readonly AgentSessionTurn[],
  toolStreams?: readonly ToolStreamEntry[],
  status?: AgentSessionStatus,
): string {
  return renderSolidToString((): JSX.Element => (
    <SessionTranscript
      agentFile={agentFile}
      executionEnvironment="bare_metal"
      filters={filters}
      messages={messages}
      {...(onFork === undefined ? {} : { onFork })}
      tools={tools}
      turns={turns}
      {...(toolStreams === undefined ? {} : { toolStreams })}
      {...(status === undefined ? {} : { status })}
    />
  ));
}

export function message(
  id: string,
  content: string,
  role: AgentSessionMessage["role"],
): AgentSessionMessage {
  return {
    content,
    createdAt: 1,
    id,
    role,
    ...EMPTY_MESSAGE_METADATA,
  };
}
