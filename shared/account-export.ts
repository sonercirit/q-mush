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
export function accountExportBlobResponse(
  blob: AccountExportBlob | undefined,
  range?: string | null,
): Response {
  if (blob === undefined) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.fromBase64(blob.data);
  const match = range?.match(/^bytes=(\d+)-$/u);
  const offset = match === null || match === undefined ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length)
    return new Response("Range not satisfiable", {
      headers: { "content-range": `bytes */${String(bytes.length)}` },
      status: 416,
    });
  const body = bytes.slice(offset);
  return new Response(body, {
    headers: {
      "accept-ranges": "bytes",
      "content-length": String(body.length),
      "content-type": "application/octet-stream",
      ...(offset > 0 && {
        "content-range": `bytes ${String(offset)}-${String(bytes.length - 1)}/${String(bytes.length)}`,
      }),
    },
    status: offset > 0 ? 206 : 200,
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

function createAccountExportInventory(
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
export function completeAccountExportInventory(
  records: readonly AccountExportRecord[],
  manifest: AccountExportInventory["manifest"],
): AccountExportInventory {
  const inventory = createAccountExportInventory(
    records,
    [...manifest].sort((a, b) => a.digest.localeCompare(b.digest)),
  );
  return { ...inventory, frontier: accountExportFrontier(inventory) };
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
