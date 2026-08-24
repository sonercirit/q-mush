import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { SessionAgentToolActions } from "./session-agent-tools.ts";
import type { SpawnedSessionCompletion } from "./session-child-lifecycle.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

export interface SessionAgentActions {
  readonly actions: (
    parentSessionId: string,
    userId: string,
    parentGeneration: number,
    toolSettings: ToolSettings,
  ) => SessionAgentToolActions;
  readonly finished: (detail: AgentSessionDetail, userId: string) => void;
  readonly isDraining: () => boolean;
  readonly reportAll: (pending: readonly PendingSpawnedSession[]) => void;
  readonly reportOne: (detail: AgentSessionDetail, userId: string) => void;
  readonly reportedParent: (
    report: SpawnedSessionCompletion,
    userId: string,
  ) => void;
  readonly stopChildren: (parent: AgentSessionDetail, userId: string) => void;
  readonly stopSession: (
    sessionId: string,
    detail?: AgentSessionDetail,
  ) => void;
}

export interface SessionAgentActionsError extends Error {
  readonly tag: "session_agent_actions";
}

export function createSessionAgentActionsError(
  message: string,
): SessionAgentActionsError {
  const error = Object.assign(new Error(message), {
    tag: "session_agent_actions" as const,
  });
  if (!isSessionAgentActionsError(error)) {
    throw new Error("Failed to create a session agent actions error");
  }
  return error;
}

function isSessionAgentActionsError(
  error: unknown,
): error is SessionAgentActionsError {
  return (
    error instanceof Error &&
    "tag" in error &&
    error.tag === "session_agent_actions"
  );
}
