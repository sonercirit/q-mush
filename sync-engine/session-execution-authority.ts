import { and, eq } from "drizzle-orm";
import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { activeSessionOwnerCondition } from "./session-store-condition.ts";

export interface SessionExecutionAuthority {
  readonly generation: number;
  readonly sessionId: string;
  readonly tool?: AgentSessionToolName;
}

export interface SessionQueueAuthorization {
  readonly deferSystemPendingInputs?: boolean;
  readonly parent?: SessionExecutionAuthority;
  readonly targetGeneration?: number;
}

function sessionExecutionCondition(
  authority: SessionExecutionAuthority,
  userId: string,
) {
  return and(
    activeSessionOwnerCondition({
      sessionId: authority.sessionId,
      userId,
    }),
    eq(agentSessions.status, "running"),
    eq(agentSessions.runnerRequired, false),
    eq(agentSessions.executionGeneration, authority.generation),
  );
}

export function sessionExecutionIsCurrent(
  database: Pick<AppDatabase, "select">,
  authority: SessionExecutionAuthority,
  userId: string,
): boolean {
  const stored = database
    .select({ tools: agentSessions.tools })
    .from(agentSessions)
    .where(sessionExecutionCondition(authority, userId))
    .get();
  if (stored === undefined) {
    return false;
  }
  if (authority.tool === undefined) {
    return true;
  }
  try {
    return (
      readAgentSessionToolNames(JSON.parse(stored.tools))?.includes(
        authority.tool,
      ) === true
    );
  } catch {
    return false;
  }
}
