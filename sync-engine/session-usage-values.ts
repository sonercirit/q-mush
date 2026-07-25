import { sql, type SQL } from "drizzle-orm";
import { agentSessions } from "../shared/database/schema.ts";
import type {
  AgentSessionCostBasis,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";

interface RuntimeUsageValues {
  readonly costBasis?: AgentSessionCostBasis | SQL;
  readonly costUsd?: number | SQL;
  readonly currentContextTokens?: number;
}

export function runtimeUsageValues(
  input: AgentSessionUsageUpdate,
): RuntimeUsageValues {
  const invalidCost =
    (input.costUsd === null) !== (input.costBasis === null) ||
    (input.costUsd !== null &&
      (!Number.isFinite(input.costUsd) || input.costUsd < 0));
  if (
    (input.contextTokens !== null &&
      (!Number.isSafeInteger(input.contextTokens) ||
        input.contextTokens < 0)) ||
    invalidCost
  ) {
    throw new Error("The agent session usage is invalid");
  }

  const context =
    input.contextTokens === null
      ? {}
      : { currentContextTokens: input.contextTokens };
  if (input.costUsd === null) {
    return context;
  }
  return {
    ...context,
    costBasis:
      input.costBasis === "estimated"
        ? "estimated"
        : sql`CASE WHEN ${agentSessions.costBasis} = 'none' THEN 'reported' ELSE ${agentSessions.costBasis} END`,
    costUsd: sql`${agentSessions.costUsd} + ${input.costUsd}`,
  };
}
