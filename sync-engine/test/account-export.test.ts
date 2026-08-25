import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { exportAccountBlob, exportAccountPage } from "../account-export.ts";
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
    const first = exportAccountPage(database, "u", 0);
    expect(first.records).toHaveLength(100);
    expect(first.done).toBe(false);
    expect(
      exportAccountPage(database, "u", first.nextOffset).records,
    ).toHaveLength(6);
  });

  test("bounds revision work independently of account payload size", () => {
    database = createUserDatabase();
    const originalQuery = database.$client.query.bind(database.$client);
    let largestRowLimit = 0;
    const boundedQueryImplementation = (sql: string) => {
      const statement = originalQuery(sql);
      if (!sql.includes("ORDER BY")) return statement;
      const originalAll = statement.all.bind(statement);
      statement.all = (userId: string, limit: number, offset: number) => {
        largestRowLimit = Math.max(largestRowLimit, limit);
        return originalAll(userId, limit, offset);
      };
      return statement;
    };
    vi.spyOn(database.$client, "query").mockImplementation(
      boundedQueryImplementation,
    );
    exportAccountPage(database, "u", 0);
    expect(largestRowLimit).toBeLessThanOrEqual(100);
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
      const page = exportAccountPage(database, "u", 0);
      const prompt = page.records.find(({ id }) => id === "p");
      expect(wroteDuringPage).toBe(true);
      expect(prompt?.payload).toContain('"name":"before"');
      expect(exportAccountPage(database, "u", 0).revision).not.toBe(
        page.revision,
      );
    } finally {
      writer.close();
    }
  });

  test("keeps the revision stable across runner presence heartbeats", () => {
    database = createUserDatabase();
    database.$client.run(
      "INSERT INTO runners (id, user_id, token_hash, token_digest, last_seen_at, created_at, updated_at, created_by_id, updated_by_id, is_deleted, is_default, is_global) VALUES ('r', 'u', 'h', 'd', 1, 1, 1, 'u', 'u', 0, 0, 0)",
    );
    const first = exportAccountPage(database, "u", 0, 1);
    database.$client.run("UPDATE runners SET last_seen_at = 2 WHERE id = 'r'");
    const second = exportAccountPage(database, "u", first.nextOffset, 1);
    expect(second.revision).toBe(first.revision);
    expect(second.records).toHaveLength(1);
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
    vi.spyOn(blobClient, "query").mockImplementation((sql) => {
      const statement = originalQuery(sql);
      if (!sql.includes('AS value FROM "agent_messages"')) return statement;
      const originalIterate = statement.iterate.bind(statement);
      statement.all = () => {
        throw new Error("blob lookup materialized attachment rows");
      };
      statement.iterate = (userId: string) => {
        usedIterator = true;
        return originalIterate(userId);
      };
      return statement;
    });
    expect(exportAccountBlob(database, "u", TEST_ATTACHMENT_DIGEST)?.size).toBe(
      3,
    );
    expect(usedIterator).toBe(true);
    expectDatabaseUsable(database);
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
    exportAccountPage(database, "u", 0, 1);
    exportAccountPage(database, "u", 0, 1);
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
    const exported = exportAccountPage(database, "u", 0);
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
