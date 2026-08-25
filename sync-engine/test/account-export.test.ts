import { Database } from "bun:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ACCOUNT_EXPORT_ENTITIES } from "../../shared/account-export.ts";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
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
} from "../../shared/database/schema.ts";
import { exportAccountBlob, exportAccountPage } from "../account-export.ts";
import { createRunnerStore } from "../runner-store.ts";
import {
  TEST_ATTACHMENT_DATA,
  TEST_ATTACHMENT_DIGEST,
} from "./account-export-test-attachments.ts";

let database: AppDatabase | undefined;
afterEach(() => database?.$client.close());

function hasBlobCacheTable(database: AppDatabase): boolean {
  return (
    database.$client
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name = 'account_export_blobs'",
      )
      .get() !== null
  );
}

function insertUser(database: AppDatabase): void {
  database.$client.run(
    "INSERT INTO users (id, google_subject, email, name, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('u', 'g', 'e', 'n', 1, 1, 'u', 'u', 0)",
  );
}

function createUserDatabase(): AppDatabase {
  const result = createDatabase(":memory:");
  insertUser(result);
  return result;
}
function createAttachmentDatabase(): AppDatabase {
  const result = createUserDatabase();
  result.$client.run("PRAGMA foreign_keys = OFF");
  return result;
}
function expectDatabaseUsable(database: AppDatabase): void {
  expect(database.$client.query("SELECT 1").get()).toEqual({ "1": 1 });
}
function bindDatabaseQuery(database: AppDatabase) {
  return database.$client.query.bind(database.$client);
}
function instrumentDatabase(
  implementation: (
    originalQuery: AppDatabase["$client"]["query"],
    sql: string,
  ) => ReturnType<AppDatabase["$client"]["query"]>,
): AppDatabase {
  const result = createUserDatabase();
  const originalQuery = bindDatabaseQuery(result);
  vi.spyOn(result.$client, "query").mockImplementation((sql) =>
    implementation(originalQuery, sql),
  );
  return result;
}
function expectPresenceDoesNotChangeRevision(
  database: AppDatabase,
  revision: string,
  cursor: string | undefined,
): void {
  const updatedAt = database.$client
    .query<{ updatedAt: number }, []>(
      "SELECT updated_at AS updatedAt FROM runners WHERE id = 'r'",
    )
    .get()?.updatedAt;
  expect(updatedAt).toBe(1);
  expect(exportAccountPage(database, "u", cursor, 1).revision).toBe(revision);
}

describe("legacy account export", () => {
  test("bounds each database export page", () => {
    database = createDatabase(
      join(mkdtempSync(join(tmpdir(), "export-page-")), "db"),
    );
    insertUser(database);
    const insert = database.$client.prepare(
      "INSERT INTO prompts (id, user_id, name, normalized_name, body, revision, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, 'u', ?, ?, 'body', 1, 1, 1, 'u', 'u', 0)",
    );
    for (let index = 0; index < 105; index += 1) {
      const id = `p-${String(index).padStart(3, "0")}`;
      insert.run(id, id, id);
    }
    const first = exportAccountPage(database, "u");
    expect(first.records).toHaveLength(100);
    expect(first.done).toBe(false);
    expect(
      exportAccountPage(database, "u", first.nextCursor).records,
    ).toHaveLength(6);
  });

  test("uses bounded offset-free keyset row queries", () => {
    let largestRowLimit = 0;
    let usedOffset = false;
    const boundedQueryImplementation = (
      originalQuery: AppDatabase["$client"]["query"],
      sql: string,
    ) => {
      const statement = originalQuery(sql);
      if (!sql.includes("ORDER BY")) return statement;
      usedOffset ||= sql.includes(" OFFSET ");
      const originalAll = statement.all.bind(statement);
      statement.all = (userId: string, afterId: string, limit: number) => {
        largestRowLimit = Math.max(largestRowLimit, limit);
        return originalAll(userId, afterId, limit);
      };
      return statement;
    };
    database = instrumentDatabase(boundedQueryImplementation);
    exportAccountPage(database, "u");
    expect(largestRowLimit).toBeGreaterThan(0);
    expect(largestRowLimit).toBeLessThanOrEqual(100);
    expect(usedOffset).toBe(false);
  });

  test("reads the revision and page rows from one database snapshot", () => {
    const path = join(mkdtempSync(join(tmpdir(), "export-snapshot-")), "db");
    database = createDatabase(path);
    insertUser(database);
    database.$client.run("PRAGMA journal_mode = WAL");
    database.$client.run(
      "INSERT INTO prompts (id, user_id, name, normalized_name, body, revision, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('p', 'u', 'before', 'before', 'body', 1, 1, 1, 'u', 'u', 0)",
    );
    const writer = new Database(path);
    writer.run("PRAGMA journal_mode = WAL");
    const snapshotClient = database.$client;
    const originalQuery = snapshotClient.query.bind(snapshotClient);
    let wroteDuringPage = false;
    vi.spyOn(snapshotClient, "query").mockImplementation((sql) => {
      if (
        !wroteDuringPage &&
        sql.includes('FROM "prompts"') &&
        sql.includes("ORDER BY")
      ) {
        wroteDuringPage = true;
        writer.run(
          "UPDATE prompts SET name = 'after', normalized_name = 'after', updated_at = 2 WHERE id = 'p'",
        );
      }
      return originalQuery(sql);
    });
    try {
      const page = exportAccountPage(database, "u");
      const prompt = page.records.find(({ id }) => id === "p");
      expect(wroteDuringPage).toBe(true);
      expect(prompt?.payload).toContain('"name":"before"');
      expect(exportAccountPage(database, "u").revision).not.toBe(page.revision);
    } finally {
      writer.close();
    }
  });

  test("keeps the revision and durable audit time stable across runner presence changes", () => {
    database = createUserDatabase();
    database.$client.run(
      "INSERT INTO runners (id, user_id, token_hash, token_digest, machine_fingerprint, last_seen_at, created_at, updated_at, created_by_id, updated_by_id, is_deleted, is_default, is_global) VALUES ('r', 'u', 'h', 'd', 'machine', 1, 1, 1, 'u', 'u', 0, 0, 0)",
    );
    const store = createRunnerStore(database);
    const first = exportAccountPage(database, "u", undefined, 1);

    store.setOnline("r", "u", 2, true);
    const online = store.list("u", 2)[0];
    expect(online).toMatchObject({ id: "r", lastSeenAt: 2, status: "online" });
    expectPresenceDoesNotChangeRevision(
      database,
      first.revision,
      first.nextCursor,
    );

    store.setOnline("r", "u", 3, false);
    const offline = store.list("u", Number.MAX_SAFE_INTEGER)[0];
    expect(offline).toMatchObject({
      id: "r",
      lastSeenAt: 0,
      status: "offline",
    });
    expectPresenceDoesNotChangeRevision(
      database,
      first.revision,
      first.nextCursor,
    );
  });

  test("rejects malformed blob digests without querying the database", () => {
    database = createDatabase(":memory:");
    database.$client.run(
      "ALTER TABLE agent_messages RENAME TO hidden_messages",
    );
    database.$client.run(
      "CREATE VIEW agent_messages AS SELECT missing_export_guard() AS content, missing_export_guard() AS images, 'u' AS user_id",
    );
    expect(exportAccountBlob(database, "u", "not-a-digest")).toBeUndefined();
    expect(hasBlobCacheTable(database)).toBe(false);
    expectDatabaseUsable(database);
  });

  test("streams blob lookup rows and finalizes after an early match", () => {
    database = createAttachmentDatabase();
    database.$client.run(
      "INSERT INTO agent_messages (id, user_id, session_id, role, content, images, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('first', 'u', 's', 'user', ?, '', 1, 1, 'u', 'u', 0), ('second', 'u', 's', 'user', ?, '', 1, 1, 'u', 'u', 0)",
      [
        JSON.stringify([{ data: TEST_ATTACHMENT_DATA }]),
        JSON.stringify([{ data: "not-base64!" }]),
      ],
    );
    const blobClient = database.$client;
    const originalQuery = blobClient.query.bind(blobClient);
    let usedIterator = false;
    let finalizedStatements = 0;
    vi.spyOn(blobClient, "query").mockImplementation((sql) => {
      const statement = originalQuery(sql);
      if (!sql.includes('AS value FROM "agent_messages"')) return statement;
      const originalIterate = statement.iterate.bind(statement);
      const originalFinalize = statement.finalize.bind(statement);
      statement.all = () => {
        throw new Error("blob lookup materialized attachment rows");
      };
      statement.iterate = (userId: string) => {
        usedIterator = true;
        return originalIterate(userId);
      };
      statement.finalize = () => {
        finalizedStatements += 1;
        originalFinalize();
      };
      return statement;
    });
    expect(exportAccountBlob(database, "u", TEST_ATTACHMENT_DIGEST)?.size).toBe(
      3,
    );
    expect(usedIterator).toBe(true);
    expect(finalizedStatements).toBeGreaterThan(0);
    expectDatabaseUsable(database);
  });

  test("invalidates a continuation revision after another connection commits", () => {
    const path = join(mkdtempSync(join(tmpdir(), "export-version-")), "db");
    database = createDatabase(path);
    insertUser(database);
    const first = exportAccountPage(database, "u", undefined, 1);
    const writer = new Database(path);
    writer.run("UPDATE users SET updated_at = 2 WHERE id = 'u'");
    writer.close();
    expect(
      exportAccountPage(database, "u", first.nextCursor, 1).revision,
    ).not.toBe(first.revision);
  });

  test("keeps exported keyset indexes in schema declarations and migrations", () => {
    database = createUserDatabase();
    const schemaTables = [
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
    ];
    const exportedTableNames = new Set<string>(ACCOUNT_EXPORT_ENTITIES);
    const exportedTables = schemaTables.filter((table) =>
      exportedTableNames.has(getTableConfig(table).name),
    );
    const tableNames = exportedTables.map(
      (table) => getTableConfig(table).name,
    );
    const declared = exportedTables.flatMap((table) =>
      getTableConfig(table)
        .indexes.map(({ config }) => config.name)
        .filter((name) => name.endsWith("_index")),
    );
    const placeholders = tableNames.map(() => "?").join(",");
    const migrated = database.$client
      .query<{ name: string }, string[]>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN (${placeholders}) AND name LIKE '%_index'`,
      )
      .all(...tableNames)
      .map(({ name }) => name);
    expect(new Set(migrated)).toEqual(new Set(declared));
  });

  test("uses owner and id indexes for exported keyset pages", () => {
    database = createUserDatabase();
    const plans = database.$client
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT id FROM prompts WHERE user_id = 'u' AND id > '' ORDER BY id LIMIT 100",
      )
      .all();
    expect(
      plans.some(({ detail }) => detail.includes("prompts_user_id_index")),
    ).toBe(true);
    expect(plans.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(
      false,
    );
  });

  test("reuses revision aggregates while the database is unchanged", () => {
    let aggregateQueries = 0;
    database = instrumentDatabase((originalQuery, sql) => {
      if (sql.includes("COUNT(*)")) aggregateQueries += 1;
      return originalQuery(sql);
    });
    const first = exportAccountPage(database, "u", undefined, 1);
    const initialQueries = aggregateQueries;
    expect(initialQueries).toBeGreaterThan(0);
    exportAccountPage(database, "u", first.nextCursor, 1);
    expect(aggregateQueries).toBe(initialQueries);
    database.$client.run("UPDATE users SET updated_at = 2 WHERE id = 'u'");
    exportAccountPage(database, "u", undefined, 1);
    expect(aggregateQueries).toBeGreaterThan(initialQueries);
  });

  test("finds an attachment added after an earlier blob lookup", () => {
    database = createAttachmentDatabase();
    expect(exportAccountBlob(database, "u", "0".repeat(64))).toBeUndefined();
    const data = TEST_ATTACHMENT_DATA;
    database.$client.run(
      "INSERT INTO agent_sessions (id, user_id, workspace_id, runner_id, provider_credential_id, title, status, provider, model, reasoning_effort, tools, working_directory, execution_environment, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('s', 'u', 'w', 'r', 'c', 't', 'idle', 'openai', 'm', 'none', '[]', '/', 'bare_metal', 1, 1, 'u', 'u', 0)",
    );
    database.$client.run(
      "INSERT INTO agent_messages (id, user_id, session_id, role, content, images, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('m', 'u', 's', 'user', '', ?, 1, 1, 'u', 'u', 0)",
      [JSON.stringify([{ data, mediaType: "image/png" }])],
    );
    const digest = TEST_ATTACHMENT_DIGEST;
    expect(exportAccountBlob(database, "u", digest)).toMatchObject({
      data,
      digest,
      size: 3,
    });
    exportAccountPage(database, "u", undefined, 1);
    exportAccountPage(database, "u", undefined, 1);
    expect(exportAccountBlob(database, "u", digest)?.data).toBe(data);
    expect(hasBlobCacheTable(database)).toBe(false);
  });

  test("exports tombstones while structurally excluding login and provider secrets", () => {
    database = createDatabase(
      join(mkdtempSync(join(tmpdir(), "export-")), "db"),
    );
    database.$client.run(
      "INSERT INTO users (id, google_subject, email, name, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('u', 'g', 'e', 'n', 1, 1, 'u', 'u', 0)",
    );
    database.$client.run(
      "INSERT INTO prompts (id, user_id, name, normalized_name, body, revision, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('p', 'u', 'n', 'n', 'body', 1, 1, 1, 'u', 'u', 1)",
    );
    database.$client.run(
      "INSERT INTO provider_credentials (id, user_id, provider, label, source, encrypted_credential, credential_fingerprint, created_at, updated_at, created_by_id, updated_by_id, is_deleted, is_default) VALUES ('c', 'u', 'openai', 'l', 'api_key', 'SECRET_CANARY', 'f', 1, 1, 'u', 'u', 0, 1)",
    );
    database.$client.run(
      "INSERT INTO sessions (id, user_id,  token, expires_at, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('s', 'u', 'LOGIN_CANARY', 9, 1, 1, 'u', 'u', 0)",
    );
    const exported = exportAccountPage(database, "u");
    const encoded = JSON.stringify(exported);
    expect(exported.records.find(({ id }) => id === "p")?.tombstone).toBe(true);
    expect(encoded).not.toContain("SECRET_CANARY");
    expect(encoded).not.toContain("LOGIN_CANARY");
    expect(encoded).not.toContain('"google_subject"');
    expect(exported.records.some(({ entity }) => entity === "sessions")).toBe(
      false,
    );
  });
});
