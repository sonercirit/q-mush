import { createMemo, type Accessor } from "solid-js";
import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import type { SessionTranscriptFilterName } from "./session-transcript-filters.ts";
import { createSessionTranscriptMessageGroups } from "./session-transcript-messages.ts";

export interface SessionTranscriptCounts {
  readonly filterCounts: Readonly<Record<SessionTranscriptFilterName, number>>;
  readonly toolCallArguments: ReadonlyMap<string, string>;
}

interface MutableSessionTranscriptCounts {
  readonly filterCounts: Record<SessionTranscriptFilterName, number>;
  readonly toolCallArguments: Map<string, string>;
}

function emptyTranscriptCounts(
  agentFile: AgentFile | null,
  tools: readonly AgentSessionToolName[],
): MutableSessionTranscriptCounts {
  return {
    filterCounts: {
      agentInstructions: agentFile === null ? 0 : 1,
      assistantMessages: 0,
      notices: 0,
      systemPrompt: 1,
      thinking: 0,
      toolActivity: 0,
      toolDefinitions: tools.length,
      userMessages: 0,
    },
    toolCallArguments: new Map(),
  };
}

function addTranscriptMessage(
  counts: MutableSessionTranscriptCounts,
  message: AgentSessionMessage,
): void {
  const toolCalls = addTranscriptMessageCounts(counts.filterCounts, message);
  if (toolCalls === undefined) return;
  for (const call of toolCalls) {
    counts.toolCallArguments.set(call.id, call.arguments);
  }
}

function addTranscriptMessageCounts(
  filterCounts: Record<SessionTranscriptFilterName, number>,
  message: AgentSessionMessage,
): AgentSessionMessage["toolCalls"] | undefined {
  switch (message.role) {
    case "compaction_request":
    case "error":
    case "system":
      filterCounts.notices += 1;
      break;
    case "thinking":
      filterCounts.thinking += 1;
      break;
    case "tool":
      filterCounts.toolActivity += 1;
      break;
    case "user":
      filterCounts.userMessages += 1;
      break;
    case "assistant": {
      const toolCalls = message.toolCalls;
      filterCounts.toolActivity += toolCalls.length;
      if (message.content.length > 0 || message.images.length > 0) {
        filterCounts.assistantMessages += 1;
      }
      return toolCalls;
    }
  }
  return undefined;
}

export function createSessionTranscriptCounts(
  agentFile: Accessor<AgentFile | null>,
  messages: Accessor<readonly AgentSessionMessage[]>,
  tools: Accessor<readonly AgentSessionToolName[]>,
): Accessor<SessionTranscriptCounts> {
  const messageGroups = createSessionTranscriptMessageGroups(messages);
  let previousAgentFile: AgentFile | null | undefined;
  let previousStableMessages: readonly AgentSessionMessage[] | undefined;
  let previousTools: readonly AgentSessionToolName[] | undefined;
  let stableCounts: MutableSessionTranscriptCounts | undefined;

  return createMemo(() => {
    const currentAgentFile = agentFile();
    const currentGroups = messageGroups();
    const currentTools = tools();
    if (
      stableCounts === undefined ||
      previousAgentFile !== currentAgentFile ||
      previousStableMessages !== currentGroups.stable ||
      previousTools !== currentTools
    ) {
      stableCounts = emptyTranscriptCounts(currentAgentFile, currentTools);
      for (const message of currentGroups.stable) {
        addTranscriptMessage(stableCounts, message);
      }
    }

    previousAgentFile = currentAgentFile;
    previousStableMessages = currentGroups.stable;
    previousTools = currentTools;
    const streamedFilterCounts = { ...stableCounts.filterCounts };
    let streamedToolCallArguments: Map<string, string> | undefined;
    for (const message of currentGroups.streamed) {
      const toolCalls = addTranscriptMessageCounts(
        streamedFilterCounts,
        message,
      );
      if (toolCalls === undefined || toolCalls.length === 0) {
        continue;
      }
      streamedToolCallArguments ??= new Map(stableCounts.toolCallArguments);
      for (const call of toolCalls) {
        streamedToolCallArguments.set(call.id, call.arguments);
      }
    }
    return {
      filterCounts: streamedFilterCounts,
      toolCallArguments:
        streamedToolCallArguments ?? stableCounts.toolCallArguments,
    };
  });
}
