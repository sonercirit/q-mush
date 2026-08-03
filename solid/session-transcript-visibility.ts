import type { AgentSessionMessage } from "../shared/session-model.ts";
import type {
  SessionTranscriptFilterName,
  SessionTranscriptFilters,
} from "./session-transcript-filters.ts";

export const SESSION_TRANSCRIPT_FILTER_NAMES: readonly SessionTranscriptFilterName[] =
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

export function transcriptMessageIsVisible(
  message: AgentSessionMessage,
  filters: SessionTranscriptFilters,
): boolean {
  switch (message.role) {
    case "compaction_request":
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
