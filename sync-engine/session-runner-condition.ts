import { eq, type SQL } from "drizzle-orm";
import { agentSessions } from "../shared/database/schema.ts";

export function runnerSessionCondition(runnerId?: string): SQL | undefined {
  return runnerId === undefined
    ? undefined
    : eq(agentSessions.runnerId, runnerId);
}
