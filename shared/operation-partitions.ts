import type { OperationPartition } from "./operation-core.ts";

const operationEntityPartitions = {
  session: [
    "agent_sessions",
    "agent_session_operations",
    "agent_session_turns",
    "agent_pending_inputs",
    "agent_question_requests",
    "agent_messages",
  ],
  "non-session": [
    "users",
    "workspaces",
    "prompts",
    "provider_quota_settings",
    "provider_quota_reset_receipts",
    "provider_credential_workspaces",
    "attachment_fallbacks",
    "runner_workspaces",
    "tool_settings",
  ],
} as const;
const sessionEntities: ReadonlySet<string> = new Set(
  operationEntityPartitions.session,
);
const nonSessionEntities: ReadonlySet<string> = new Set(
  operationEntityPartitions["non-session"],
);

/** @public entity partition classifier for operation creation. */
export const classifyOperationPartition = (
  entityType: string,
): OperationPartition => {
  if (sessionEntities.has(entityType)) return "session";
  if (nonSessionEntities.has(entityType)) return "non-session";
  throw new Error(`Unknown operation entity: ${entityType}`);
};
