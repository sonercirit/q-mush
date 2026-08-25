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
export function findAccountExportBlob(
  blobs: readonly AccountExportBlob[] | undefined,
  digest: string,
): AccountExportBlob | undefined {
  return blobs?.find((entry) => entry.digest === digest);
}

export function accountExportBlobResponse(
  blob: AccountExportBlob | undefined,
): Response {
  return blob === undefined
    ? new Response("Not found", { status: 404 })
    : new Response(Uint8Array.fromBase64(blob.data), {
        headers: {
          "content-length": String(blob.size),
          "content-type": "application/octet-stream",
        },
      });
}

export function accountExportEntityCounts(
  records: readonly AccountExportRecord[],
): Record<string, number> {
  return Object.fromEntries(
    ACCOUNT_EXPORT_ENTITIES.map((entity) => [
      entity,
      records.filter((record) => record.entity === entity).length,
    ]),
  );
}

export function createAccountExportInventory(
  records: readonly AccountExportRecord[],
  manifest: AccountExportInventory["manifest"],
): Omit<AccountExportInventory, "frontier"> {
  return {
    entities: ACCOUNT_EXPORT_ENTITIES,
    entityCounts: accountExportEntityCounts(records),
    manifest,
    records,
  };
}

function accountExportInventoryFields(
  inventory: Omit<AccountExportInventory, "frontier">,
): Omit<AccountExportInventory, "frontier"> {
  return {
    entities: inventory.entities,
    entityCounts: inventory.entityCounts,
    manifest: inventory.manifest,
    records: inventory.records,
  };
}
export function accountExportFrontier(
  inventory: Omit<AccountExportInventory, "frontier">,
): string {
  return sha256(JSON.stringify(accountExportInventoryFields(inventory)));
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
    accountExportFrontier(accountExportInventoryFields(inventory)) ===
    inventory.frontier
  );
}
