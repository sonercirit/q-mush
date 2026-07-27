import { eq, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

export function sessionSegment(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): number | undefined {
  return sessionSegmentQuery(database, condition).get()?.segment;
}

export function currentSessionSegment(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): number | undefined {
  return sessionSegment(database, eq(agentSessions.id, sessionId));
}

export function sessionSegmentQuery(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
) {
  const selection = { segment: agentSessions.currentSegment };
  return database.select(selection).from(agentSessions).where(condition);
}
