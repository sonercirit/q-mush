import { getTableColumns, getTableName } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { createHash } from "node:crypto";
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

import type {
  AccountExport,
  AccountExportBlob,
  AccountExportRecord,
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

function publicCredentialColumns() {
  return Object.fromEntries(
    Object.entries(getTableColumns(providerCredentials)).filter(
      ([key]) => key !== "encryptedCredential" && key !== "baseUrl",
    ),
  );
}
function publicRunnerColumns() {
  return Object.fromEntries(
    Object.entries(getTableColumns(runners)).filter(
      ([key]) => key !== "tokenHash" && key !== "tokenDigest",
    ),
  );
}
function rows(
  database: AppDatabase,
  table: AnySQLiteTable,
  userId: string,
  columns: ReturnType<typeof getTableColumns> = getTableColumns(table),
): readonly Record<string, unknown>[] {
  const selection = Object.values(columns)
    .map((column) => `"${column.name}"`)
    .join(",");
  const name = getTableName(table);
  const owner = name === "users" ? "id" : "user_id";
  return database.$client
    .query<Record<string, unknown>, [string]>(
      `SELECT ${selection} FROM "${name}" WHERE "${owner}" = ? ORDER BY "id"`,
    )
    .all(userId);
}
function attachments(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.flatMap((item: unknown) => {
          if (typeof item !== "object" || item === null || !("data" in item)) {
            return [];
          }
          const data = item.data;
          return typeof data === "string" ? [data] : [];
        })
      : [];
  } catch {
    return [];
  }
}
export function exportAccount(
  database: AppDatabase,
  userId: string,
): AccountExport {
  const records: AccountExportRecord[] = [];
  const blobs = new Map<string, AccountExportBlob>();
  const add = (
    table: AnySQLiteTable,
    selected?: ReturnType<typeof getTableColumns>,
  ) => {
    const entity = getTableName(table);
    for (const row of rows(database, table, userId, selected)) {
      for (const data of [
        ...attachments(row["images"]),
        ...attachments(row["content"]),
      ]) {
        const bytes = Uint8Array.fromBase64(data);
        const digest = createHash("sha256").update(bytes).digest("hex");
        blobs.set(digest, { data, digest, size: bytes.length });
      }
      records.push({
        entity,
        id: String(row["id"]),
        payload: JSON.stringify(row),
        tombstone: row["is_deleted"] === 1,
      });
    }
  };
  for (const table of ordinaryTables) add(table);
  add(providerCredentials, publicCredentialColumns());
  add(runners, publicRunnerColumns());
  const manifest = [...blobs.values()]
    .map(({ digest, size }) => ({ digest, size }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
  const frontier = createHash("sha256")
    .update(JSON.stringify(records))
    .update(JSON.stringify(manifest))
    .digest("hex");
  return { blobs: [...blobs.values()], frontier, manifest, records };
}
