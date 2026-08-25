import { isRecord } from "./auth-model.ts";
import { isSha256Digest } from "./digest.ts";
import { sha256 } from "./sha256.ts";

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
export interface AccountExportInventory {
  readonly entities: readonly string[];
  readonly entityCounts: Readonly<Record<string, number>>;
  readonly frontier: string;
  readonly manifest: readonly {
    readonly digest: string;
    readonly size: number;
  }[];
  readonly records: readonly AccountExportRecord[];
}
export interface AccountExport extends AccountExportInventory {
  readonly blobs: readonly AccountExportBlob[];
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecordEntry(value: unknown): value is AccountExportRecord {
  if (
    !isRecord(value) ||
    typeof value["entity"] !== "string" ||
    typeof value["id"] !== "string" ||
    typeof value["payload"] !== "string" ||
    typeof value["tombstone"] !== "boolean"
  )
    return false;
  try {
    return isRecord(JSON.parse(value["payload"]));
  } catch {
    return false;
  }
}
function isManifestEntry(
  value: unknown,
): value is { readonly digest: string; readonly size: number } {
  return (
    isRecord(value) &&
    isSha256Digest(value["digest"]) &&
    isNonnegativeInteger(value["size"])
  );
}
export function accountExportFrontier(
  inventory: Omit<AccountExportInventory, "frontier">,
): string {
  return sha256(
    JSON.stringify({
      entities: inventory.entities,
      entityCounts: inventory.entityCounts,
      manifest: inventory.manifest,
      records: inventory.records,
    }),
  );
}
export function isAccountExportInventory(
  value: unknown,
): value is AccountExportInventory {
  if (
    !isRecord(value) ||
    !Array.isArray(value["entities"]) ||
    !value["entities"].every((item) => typeof item === "string") ||
    !isRecord(value["entityCounts"]) ||
    !Object.values(value["entityCounts"]).every(isNonnegativeInteger) ||
    typeof value["frontier"] !== "string" ||
    !isSha256Digest(value["frontier"]) ||
    !Array.isArray(value["manifest"]) ||
    !value["manifest"].every(isManifestEntry) ||
    !Array.isArray(value["records"]) ||
    !value["records"].every(isRecordEntry)
  )
    return false;
  const entityCounts: Record<string, number> = {};
  for (const [entity, count] of Object.entries(value["entityCounts"])) {
    if (typeof count === "number") entityCounts[entity] = count;
  }
  const inventory: AccountExportInventory = {
    entities: value["entities"],
    entityCounts,
    frontier: value["frontier"],
    manifest: value["manifest"],
    records: value["records"],
  };
  return (
    accountExportFrontier({
      entities: inventory.entities,
      entityCounts: inventory.entityCounts,
      manifest: inventory.manifest,
      records: inventory.records,
    }) === inventory.frontier
  );
}
export function isAccountExport(value: unknown): value is AccountExport {
  return (
    isAccountExportInventory(value) &&
    "blobs" in value &&
    Array.isArray(value.blobs) &&
    value.blobs.every(
      (blob) =>
        isManifestEntry(blob) &&
        "data" in blob &&
        typeof blob.data === "string",
    )
  );
}
