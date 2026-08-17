import { isTruncationNotice } from "../shared/agent-loop.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../shared/session-model.ts";
import { sessionToolOutput } from "./session-agent-tools.ts";
import { sanitizedTerminalEventText } from "./session-terminal-event.ts";

export interface ParentSessionReport {
  readonly content: string;
  readonly parentId: string;
}

function currentGenerationMessages(
  completed: AgentSessionDetail,
): readonly AgentSessionMessage[] {
  const generationTurns =
    completed.turns?.filter(
      ({ executionGeneration }) => executionGeneration === completed.generation,
    ) ?? [];
  const firstTurn = generationTurns.at(0);
  if (firstTurn === undefined) return completed.messages;
  const turnIds = new Set(generationTurns.map(({ id }) => id));
  return completed.messages.filter(
    ({ turnId }) =>
      turnId !== null && turnId !== undefined && turnIds.has(turnId),
  );
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
  const messages = currentGenerationMessages(completed);
  const terminalAssistant = messages.findLast(
    ({ role, toolCalls }) => role === "assistant" && toolCalls.length === 0,
  );
  // A truncation notice lands directly after its assistant step; carry it
  // into the callback so the parent never mistakes a cut-short answer for
  // a finished one.
  const terminalIndex =
    terminalAssistant === undefined ? -1 : messages.indexOf(terminalAssistant);
  const trailingNotice =
    terminalIndex >= 0 ? messages[terminalIndex + 1] : undefined;
  const noticedAssistant =
    terminalAssistant !== undefined &&
    trailingNotice?.role === "error" &&
    isTruncationNotice(trailingNotice.content)
      ? {
          ...terminalAssistant,
          content: `${terminalAssistant.content}\n\n${trailingNotice.content}`,
        }
      : terminalAssistant;
  const assistant = messages.findLast(({ role }) => role === "assistant");
  const failure = failed
    ? messages.findLast(({ role }) => role === "error")
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
      ? messages.findLast(({ role }) => role !== "thinking")
      : noticedAssistant;
  const summary = sessionToolOutput({
    generation: completed.generation,
    lastMessage:
      lastMessage === undefined
        ? null
        : {
            content: sanitizedTerminalEventText(lastMessage.content),
            role: lastMessage.role,
          },
    sessionId: completed.id,
    status: completed.status,
  });
  return {
    content: `Spawned session ${completed.status}:\n${summary}`,
    parentId,
  };
}
