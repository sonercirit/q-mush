export const ACCOUNT_EXPORT_ENTITIES = [
  "users",
  "workspaces",
  "prompts",
  "tool_settings",
  "provider_quota_settings",
  "provider_quota_reset_receipts",
  "provider_credential_workspaces",
  "attachment_fallbacks",
  "runner_workspaces",
  "agent_sessions",
  "agent_session_operations",
  "agent_session_turns",
  "agent_pending_inputs",
  "agent_question_requests",
  "agent_messages",
  "provider_credentials",
  "runners",
] as const;

export interface AccountExportRecord {
  readonly entity: string;
  readonly id: string;
  readonly payload: string;
  readonly tombstone: boolean;
}
export interface AccountExportBlob {
  readonly data: string;
  readonly digest: string;
  readonly size: number;
}
export interface AccountExport {
  readonly blobs: readonly AccountExportBlob[];
  readonly entities: readonly string[];
  readonly frontier: string;
  readonly manifest: readonly {
    readonly digest: string;
    readonly size: number;
  }[];
  readonly records: readonly AccountExportRecord[];
}

export function isAccountExport(value: unknown): value is AccountExport {
  return (
    typeof value === "object" &&
    value !== null &&
    "blobs" in value &&
    Array.isArray(value.blobs) &&
    "entities" in value &&
    Array.isArray(value.entities) &&
    "frontier" in value &&
    typeof value.frontier === "string" &&
    "manifest" in value &&
    Array.isArray(value.manifest) &&
    "records" in value &&
    Array.isArray(value.records)
  );
}
