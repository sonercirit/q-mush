import { getTableColumns, getTableName } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentMessages,
  agentPendingInputs,
  agentQuestionRequests,
  agentSessionOperations,
  agentSessions,
  agentSessionTurns,
  attachmentFallbacks,
  prompts,
  providerCredentials,
  providerCredentialWorkspaces,
  providerQuotaResetReceipts,
  providerQuotaSettings,
  runners,
  runnerWorkspaces,
  toolSettings,
  users,
  workspaces,
} from "../shared/database/schema.ts";
import { parseSerializedArray } from "../shared/serialized-array.ts";
import { sha256 } from "../shared/sha256.ts";

import {
  accountExportFrontier,
  createAccountExportInventory,
  type AccountExport,
  type AccountExportBlob,
  type AccountExportRecord,
} from "../shared/account-export.ts";

const ordinaryTables = [
  users,
  workspaces,
  prompts,
  toolSettings,
  providerQuotaSettings,
  providerQuotaResetReceipts,
  providerCredentialWorkspaces,
  attachmentFallbacks,
  runnerWorkspaces,
  agentSessions,
  agentSessionOperations,
  agentSessionTurns,
  agentPendingInputs,
  agentQuestionRequests,
  agentMessages,
] as const;

const PUBLIC_CREDENTIAL_COLUMNS = [
  "id",
  "userId",
  "provider",
  "providerAccountId",
  "apiFormat",
  "label",
  "source",
  "requiresReauthentication",
  "isDefault",
  "isGlobal",
  "createdAt",
  "updatedAt",
  "createdById",
  "updatedById",
  "isDeleted",
] as const;
const PUBLIC_RUNNER_COLUMNS = [
  "id",
  "userId",
  "name",
  "machineFingerprint",
  "platform",
  "architecture",
  "activationGeneration",
  "activationId",
  "activationPhase",
  "activationRestartId",
  "activationLifecycle",
  "activationLifecycleSettled",
  "activationSourceId",
  "activationTargetId",
  "activationTargetGeneration",
  "activationReservationId",
  "activationReservationGeneration",
  "activationReservationSourceId",
  "activationMachineFingerprint",
  "activationPlatform",
  "activationArchitecture",
  "activationName",
  "lastSeenAt",
  "isDefault",
  "createdAt",
  "updatedAt",
  "createdById",
  "updatedById",
  "isDeleted",
] as const;
function allowedColumns(table: AnySQLiteTable, names: readonly string[]) {
  const columns = getTableColumns(table);
  return Object.fromEntries(
    names.map((name) => {
      const column = columns[name];
      if (column === undefined)
        throw new Error(`Unknown exported column ${name}`);
      return [name, column];
    }),
  );
}
function publicCredentialColumns() {
  return allowedColumns(providerCredentials, PUBLIC_CREDENTIAL_COLUMNS);
}
function publicRunnerColumns() {
  return allowedColumns(runners, PUBLIC_RUNNER_COLUMNS);
}
function rewriteAttachments(
  value: unknown,
  blobs: Map<string, AccountExportBlob>,
) {
  const parsed = parseSerializedArray(value);
  if (parsed.length === 0) return value;
  return JSON.stringify(
    parsed.map((item) => {
      if (typeof item !== "object" || item === null || !("data" in item))
        return item;
      const data = item.data;
      if (typeof data !== "string") return item;
      const bytes = Uint8Array.fromBase64(data);
      const digest = sha256(bytes);
      blobs.set(digest, { data, digest, size: bytes.length });
      const { data: omitted, ...metadata } = item;
      void omitted;
      return { ...metadata, digest };
    }),
  );
}
interface ExportAccumulator {
  readonly blobs: Map<string, AccountExportBlob>;
  readonly records: AccountExportRecord[];
}
function createExportAccumulator(): ExportAccumulator {
  return { blobs: new Map(), records: [] };
}
const ACCOUNT_EXPORT_PAGE_LIMIT = 100;
export interface AccountExportPage {
  readonly blobs: readonly AccountExportBlob[];
  readonly done: boolean;
  readonly nextOffset: number;
  readonly records: readonly AccountExportRecord[];
}
const exportedTables = [
  ...ordinaryTables.map((table) => ({ table, selected: undefined })),
  { table: providerCredentials, selected: publicCredentialColumns() },
  { table: runners, selected: publicRunnerColumns() },
] as const;
function boundedRows(
  database: AppDatabase,
  table: AnySQLiteTable,
  userId: string,
  limit: number,
  offset: number,
  columns: ReturnType<typeof getTableColumns> = getTableColumns(table),
): readonly Record<string, unknown>[] {
  const selection = Object.values(columns).reduce(
    (sql, column, index) => `${sql}${index === 0 ? "" : ","}"${column.name}"`,
    "",
  );
  const name = getTableName(table);
  const owner = name === "users" ? "id" : "user_id";
  return database.$client
    .query<Record<string, unknown>, [string, number, number]>(
      `SELECT ${selection} FROM "${name}" WHERE "${owner}" = ? ORDER BY "id" LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset);
}
export function exportAccountPage(
  database: AppDatabase,
  userId: string,
  offset: number,
  limit = ACCOUNT_EXPORT_PAGE_LIMIT,
): AccountExportPage {
  const safeLimit = Math.min(ACCOUNT_EXPORT_PAGE_LIMIT, Math.max(1, limit));
  const accumulator = createExportAccumulator();
  const { blobs, records } = accumulator;
  let skipped = 0;
  for (const { table, selected } of exportedTables) {
    if (records.length >= safeLimit) break;
    const name = getTableName(table);
    const ownershipColumn = name === "users" ? "id" : "user_id";
    const count =
      database.$client
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM "${name}" WHERE "${ownershipColumn}" = ?`,
        )
        .get(userId)?.count ?? 0;
    if (offset >= skipped + count) {
      skipped += count;
      continue;
    }
    const tableOffset = Math.max(0, offset - skipped);
    for (const originalRow of boundedRows(
      database,
      table,
      userId,
      safeLimit - records.length,
      tableOffset,
      selected,
    )) {
      const row = { ...originalRow };
      for (const field of ["images", "content"] as const)
        if (field in row) row[field] = rewriteAttachments(row[field], blobs);
      records.push({
        entity: getTableName(table),
        id: String(row["id"]),
        payload: JSON.stringify(row),
        tombstone: row["is_deleted"] === 1,
      });
    }
    skipped += count;
  }
  const nextOffset = offset + records.length;
  return {
    blobs: [...blobs.values()],
    done: records.length < safeLimit,
    nextOffset,
    records,
  };
}
export function exportAccountBlob(
  database: AppDatabase,
  userId: string,
  digest: string,
): AccountExportBlob | undefined {
  let page = exportAccountPage(database, userId, 0);
  while (!page.done) {
    const blob = page.blobs.find((entry) => entry.digest === digest);
    if (blob !== undefined) return blob;
    page = exportAccountPage(database, userId, page.nextOffset);
  }
  return page.blobs.find((entry) => entry.digest === digest);
}

export function exportAccount(
  database: AppDatabase,
  userId: string,
): AccountExport {
  const accumulator = createExportAccumulator();
  const { blobs, records } = accumulator;
  let offset = 0;
  let done = false;
  while (!done) {
    const page = exportAccountPage(database, userId, offset);
    records.push(...page.records);
    for (const blob of page.blobs) blobs.set(blob.digest, blob);
    offset = page.nextOffset;
    done = page.done;
  }
  const manifest = [...blobs.values()]
    .map(({ digest, size }) => ({ digest, size }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
  const inventory = createAccountExportInventory(records, manifest);
  return {
    ...inventory,
    blobs: [...blobs.values()],
    frontier: accountExportFrontier(inventory),
  };
}
