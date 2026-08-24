import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

export function sessionDetail(
  changes: Partial<AgentSessionDetail> = {},
): AgentSessionDetail {
  return { ...TEST_SESSION_DETAIL, ...changes };
}

export function createdSessionDetail(
  prompt: string,
  changes: Partial<AgentSessionDetail> = {},
): AgentSessionDetail {
  return sessionDetail({
    ...changes,
    messages: changes.messages ?? [
      transcriptMessage("created-user", prompt, "user", 2),
    ],
  });
}

export function sessionUserMessage(
  id: string,
  content: string,
  createdAt: number,
): AgentSessionDetail["messages"][number] {
  return transcriptMessage(id, content, "user", createdAt);
}
