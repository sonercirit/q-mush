import { isTruncationNotice } from "../shared/agent-loop.ts";
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
  // A truncation notice lands directly after its assistant step; carry it
  // into the callback so the parent never mistakes a cut-short answer for
  // a finished one.
  const terminalIndex =
    terminalAssistant === undefined
      ? -1
      : completed.messages.indexOf(terminalAssistant);
  const trailingNotice =
    terminalIndex >= 0 ? completed.messages[terminalIndex + 1] : undefined;
  const noticedAssistant =
    terminalAssistant !== undefined &&
    trailingNotice?.role === "error" &&
    isTruncationNotice(trailingNotice.content)
      ? {
          ...terminalAssistant,
          content: `${terminalAssistant.content}\n\n${trailingNotice.content}`,
        }
      : terminalAssistant;
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
      : noticedAssistant;
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
