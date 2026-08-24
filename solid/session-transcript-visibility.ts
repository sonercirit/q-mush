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

type Role = AgentSessionMessage["role"];
type VisibilityHandler = (
  message: AgentSessionMessage,
  filters: SessionTranscriptFilters,
) => boolean;
type VisibilityHandlers = Record<Role, VisibilityHandler>;

const visibilityHandlers: VisibilityHandlers = {
  assistant: (message, filters) =>
    (filters.assistantMessages &&
      (message.content.length > 0 || message.images.length > 0)) ||
    (filters.toolActivity && message.toolCalls.length > 0),
  compaction_request: (_message, filters) => filters.notices,
  error: (_message, filters) => filters.notices,
  system: (_message, filters) => filters.notices,
  thinking: (_message, filters) => filters.thinking,
  tool: (_message, filters) => filters.toolActivity,
  user: (_message, filters) => filters.userMessages,
};

export function transcriptMessageIsVisible(
  message: AgentSessionMessage,
  filters: SessionTranscriptFilters,
): boolean {
  return visibilityHandlers[message.role](message, filters);
}
