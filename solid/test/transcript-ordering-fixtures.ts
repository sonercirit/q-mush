import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import { createDisplaySessionMessage } from "../session-message.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

export function transcriptMessage(
  id: string,
  content: string,
  role: "assistant" | "thinking" | "user",
  createdAt: number,
): AgentSessionMessage {
  return createDisplaySessionMessage({ content, createdAt, id, role });
}

export function sessionDetailWithStatus(
  status: AgentSessionDetail["status"],
  messages: AgentSessionDetail["messages"],
  id: string,
): AgentSessionDetail {
  return { ...TEST_SESSION_DETAIL, id, messages, status };
}

export function runningSessionDetail(
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail {
  return sessionDetailWithStatus("running", messages, TEST_SESSION_DETAIL.id);
}
