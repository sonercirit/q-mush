import { getTableColumns, getTableName } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { decodeBase64 } from "../shared/base64.ts";
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
import { isSha256Digest } from "../shared/digest.ts";
import { parseSerializedArray } from "../shared/serialized-array.ts";
import { sha256 } from "../shared/sha256.ts";

import {
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

const PUBLIC_USER_COLUMNS = [
  "id",
  "email",
  "name",
  "createdAt",
  "updatedAt",
  "createdById",
  "updatedById",
  "isDeleted",
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
function publicUserColumns() {
  return allowedColumns(users, PUBLIC_USER_COLUMNS);
}
function publicCredentialColumns() {
  return allowedColumns(providerCredentials, PUBLIC_CREDENTIAL_COLUMNS);
}
function publicRunnerColumns() {
  return allowedColumns(runners, PUBLIC_RUNNER_COLUMNS);
}
export function rewriteAccountAttachments(
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
      const bytes = decodeBase64(data);
      if (bytes === undefined) return item;
      const digest = sha256(bytes);
      const blob = { data, digest, size: bytes.length };
      blobs.set(digest, blob);
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
  readonly revision: string;
}
function accountExportRevision(database: AppDatabase, userId: string): string {
  const states = exportedTables.map(({ table }) => {
    const name = getTableName(table);
    const owner = name === "users" ? "id" : "user_id";
    const state = database.$client
      .query<{ count: number; updatedAt: number | null }, [string]>(
        `SELECT COUNT(*) AS count, MAX("updated_at") AS updatedAt FROM "${name}" WHERE "${owner}" = ?`,
      )
      .get(userId);
    return `${name}:${String(state?.count ?? 0)}:${String(state?.updatedAt ?? 0)}`;
  });
  return sha256(new TextEncoder().encode(states.join("\n")));
}
const exportedTables = [
  ...ordinaryTables
    .filter((table) => table !== users)
    .map((table) => ({ table, selected: undefined })),
  { table: users, selected: publicUserColumns() },
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
  return database.$client.transaction(() => {
    const revision = accountExportRevision(database, userId);
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
          if (field in row)
            row[field] = rewriteAccountAttachments(row[field], blobs);
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
      revision,
    };
  })();
}
export function exportAccountBlob(
  database: AppDatabase,
  userId: string,
  digest: string,
): AccountExportBlob | undefined {
  if (!isSha256Digest(digest)) return undefined;
  const attachmentColumns = [
    ["agent_messages", "content"],
    ["agent_messages", "images"],
    ["agent_pending_inputs", "content"],
    ["agent_pending_inputs", "images"],
  ] as const;
  for (const [table, column] of attachmentColumns) {
    const statement = database.$client.query<Record<string, unknown>, [string]>(
      `SELECT "${column}" AS value FROM "${table}" WHERE "user_id" = ? AND "${column}" IS NOT NULL`,
    );
    try {
      for (const row of statement.iterate(userId)) {
        for (const item of parseSerializedArray(row["value"])) {
          if (typeof item !== "object" || item === null || !("data" in item))
            continue;
          const data = item.data;
          if (typeof data !== "string") continue;
          const bytes = decodeBase64(data);
          if (bytes === undefined) continue;
          if (sha256(bytes) === digest)
            return { data, digest, size: bytes.length };
        }
      }
    } finally {
      statement.finalize();
    }
  }
  return undefined;
}
