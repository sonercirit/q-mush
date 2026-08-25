import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { exportAccountBlob, exportAccountPage } from "../account-export.ts";

let database: AppDatabase | undefined;
afterEach(() => database?.$client.close());

describe("legacy account export", () => {
  test("bounds each database export page", () => {
    database = createDatabase(
      join(mkdtempSync(join(tmpdir(), "export-page-")), "db"),
    );
    database.$client.run(
      "INSERT INTO users (id, google_subject, email, name, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('u', 'g', 'e', 'n', 1, 1, 'u', 'u', 0)",
    );
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

  test("rejects malformed blob digests without querying the database", () => {
    database = createDatabase(":memory:");
    expect(exportAccountBlob(database, "u", "not-a-digest")).toBeUndefined();
    expect(
      database.$client
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'account_export_blobs'",
        )
        .get(),
    ).toBeNull();
  });

  test("finds an attachment added after an earlier blob lookup", () => {
    database = createDatabase(":memory:");
    database.$client.run(
      "INSERT INTO users (id, google_subject, email, name, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('u', 'g', 'e', 'n', 1, 1, 'u', 'u', 0)",
    );
    database.$client.run("PRAGMA foreign_keys = OFF");
    expect(exportAccountBlob(database, "u", "0".repeat(64))).toBeUndefined();
    const data = Uint8Array.from([1, 2, 3]).toBase64();
    database.$client.run(
      "INSERT INTO agent_sessions (id, user_id, workspace_id, runner_id, provider_credential_id, title, status, provider, model, reasoning_effort, tools, working_directory, execution_environment, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('s', 'u', 'w', 'r', 'c', 't', 'idle', 'openai', 'm', 'none', '[]', '/', 'bare_metal', 1, 1, 'u', 'u', 0)",
    );
    database.$client.run(
      "INSERT INTO agent_messages (id, user_id, session_id, role, content, images, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES ('m', 'u', 's', 'user', '', ?, 1, 1, 'u', 'u', 0)",
      [JSON.stringify([{ data, mediaType: "image/png" }])],
    );
    const digest = exportAccountPage(database, "u", 0).blobs[0]?.digest;
    expect(digest).toBeDefined();
    expect(exportAccountBlob(database, "u", digest ?? "")).toMatchObject({
      data,
      digest,
      size: 3,
    });
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
