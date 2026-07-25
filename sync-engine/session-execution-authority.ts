import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { activeSessionOwnerCondition } from "./session-store-condition.ts";
import { storedSessionExists } from "./session-store-state.ts";

export interface SessionExecutionAuthority {
  readonly generation: number;
  readonly sessionId: string;
}

export interface SessionQueueAuthorization {
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
  return storedSessionExists(
    database,
    sessionExecutionCondition(authority, userId),
  );
}
