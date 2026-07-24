import { readAgentSessionToolNames } from "../shared/agent-tools.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { parseProviderPricing } from "./session-store-read.ts";

export interface StoredSessionSummary extends Omit<
  AgentSessionSummary,
  | "activeStartedAt"
  | "createdAt"
  | "providerLimits"
  | "providerPricing"
  | "tools"
  | "updatedAt"
> {
  readonly activeStartedAt: Date | null;
  readonly createdAt: Date;
  readonly providerPricing: string | null;
  readonly tools: string;
  readonly updatedAt: Date;
}

function parseStoredTools(value: string): AgentSessionSummary["tools"] {
  try {
    const tools = readAgentSessionToolNames(JSON.parse(value));
    if (tools !== undefined) {
      return tools;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent session tools are invalid");
}

export function summarizeStoredSession(
  stored: StoredSessionSummary,
): AgentSessionSummary {
  return {
    ...stored,
    activeStartedAt: stored.activeStartedAt?.getTime() ?? null,
    createdAt: stored.createdAt.getTime(),
    providerLimits: { status: "unavailable" },
    providerPricing: parseProviderPricing(stored.providerPricing),
    tools: parseStoredTools(stored.tools),
    updatedAt: stored.updatedAt.getTime(),
  };
}
