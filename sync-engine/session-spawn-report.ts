import type { AgentSessionDetail } from "../shared/session-model.ts";
import { sessionToolOutput } from "./session-agent-tools.ts";

export interface ParentSessionReport {
  readonly content: string;
  readonly parentId: string;
}

export function spawnedSessionReport(
  completed: AgentSessionDetail,
  parentId: string,
): ParentSessionReport | undefined {
  if (
    completed.status !== "completed" &&
    completed.status !== "failed" &&
    completed.status !== "stopped"
  ) {
    return undefined;
  }
  const failed = completed.status === "failed";
  const terminalAssistant = completed.messages.findLast(
    ({ role, toolCalls }) => role === "assistant" && toolCalls.length === 0,
  );
  const assistant = completed.messages.findLast(
    ({ role }) => role === "assistant",
  );
  const failure = failed
    ? completed.messages.findLast(({ role }) => role === "error")
    : undefined;
  const lastMessage = failed
    ? (assistant?.content.trim().length ?? 0) > 0
      ? assistant
      : {
          content:
            failure?.content ??
            "Session failed without a recorded failure reason",
          role: "error" as const,
        }
    : completed.status === "stopped"
      ? completed.messages.findLast(({ role }) => role !== "thinking")
      : terminalAssistant;
  const summary = sessionToolOutput({
    lastMessage:
      lastMessage === undefined
        ? null
        : { content: lastMessage.content, role: lastMessage.role },
    sessionId: completed.id,
    status: completed.status,
  });
  return {
    content: `Spawned session ${failed ? "failed" : "completed"}:\n${summary}`,
    parentId,
  };
}
