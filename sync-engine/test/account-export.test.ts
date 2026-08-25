import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { exportAccount } from "../account-export.ts";

let database: AppDatabase | undefined;
afterEach(() => database?.$client.close());

describe("legacy account export", () => {
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
    const exported = exportAccount(database, "u");
    const encoded = JSON.stringify(exported);
    expect(exported.records.find(({ id }) => id === "p")?.tombstone).toBe(true);
    expect(encoded).not.toContain("SECRET_CANARY");
    expect(encoded).not.toContain("LOGIN_CANARY");
    expect(exported.records.some(({ entity }) => entity === "sessions")).toBe(
      false,
    );
  });
});
