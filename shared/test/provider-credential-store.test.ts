import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { CredentialCipher } from "../../shared/credential-cipher.ts";
import { createDatabase } from "../../shared/database.ts";
import { users } from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import { ProviderCredentialStore } from "../../shared/provider-credential-store.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000051";
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";

// The migration battery covers from-scratch, legacy, and current-schema
// databases; this store test additionally exercises the legacy shape where
// credential-scope objects do not exist yet.
function ensureCredentialScopeSchema(
  database: ReturnType<typeof createDatabase>,
): void {
  const client = database.$client;
  const tableExists = (name: string): boolean =>
    client
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== null;
  if (!tableExists("workspaces")) {
    client.run(`
      CREATE TABLE workspaces (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
        name text NOT NULL,
        is_default integer NOT NULL DEFAULT false,
        created_at integer NOT NULL,
        created_by_id text NOT NULL,
        updated_at integer NOT NULL,
        updated_by_id text NOT NULL,
        is_deleted integer NOT NULL DEFAULT false
      )
    `);
  }
  const credentialColumns = new Set(
    client
      .query<{ readonly name: string }, []>(
        "PRAGMA table_info(provider_credentials)",
      )
      .all()
      .map(({ name }) => name),
  );
  if (!credentialColumns.has("is_global")) {
    client.run(
      "ALTER TABLE provider_credentials ADD COLUMN is_global integer NOT NULL DEFAULT true",
    );
  }
  if (!tableExists("provider_credential_workspaces")) {
    client.run(`
      CREATE TABLE provider_credential_workspaces (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
        provider_credential_id text NOT NULL REFERENCES provider_credentials(id) ON DELETE restrict,
        workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE restrict,
        created_at integer NOT NULL,
        created_by_id text NOT NULL,
        updated_at integer NOT NULL,
        updated_by_id text NOT NULL,
        is_deleted integer NOT NULL DEFAULT false
      )
    `);
  }
}

function createProviderStore(options?: { readonly legacySchema?: boolean }): {
  readonly close: () => void;
  readonly store: ProviderCredentialStore;
} {
  const database = createDatabase(":memory:");
  if (options?.legacySchema === true) {
    database.$client.run("DROP TABLE provider_credential_workspaces");
    database.$client.run("DROP TABLE workspaces");
    database.$client.run(
      "ALTER TABLE provider_credentials DROP COLUMN is_global",
    );
  }
  ensureCredentialScopeSchema(database);
  const user = {
    ...createdAuditFields(SYSTEM_ID, TEST_NOW),
    email: "mushroom@example.com",
    googleSubject: "google-user",
    id: TEST_USER_ID,
    name: "Mush Room",
  };
  database.insert(users).values(user).run();
  const cipher = new CredentialCipher(
    new Uint8Array(32),
    () => new Uint8Array(12),
  );
  return {
    close: () => {
      database.$client.close();
    },
    store: new ProviderCredentialStore(
      database,
      cipher,
      "openrouter",
      () => CREDENTIAL_ID,
    ),
  };
}

function addAndRead(
  store: ProviderCredentialStore,
  secret: string,
  metadata: { readonly accountId: string; readonly label: string },
): void {
  store.add(TEST_USER_ID, secret, metadata, "api_key", TEST_NOW);

  expect(store.read(TEST_USER_ID, CREDENTIAL_ID)).toEqual({
    accountId: metadata.accountId,
    id: CREDENTIAL_ID,
    label: metadata.label,
    isDefault: false,
    secret,
    source: "api_key",
  });
}

describe("provider credential agent access", () => {
  test("reads an owned active credential with its metadata and secret", () => {
    const { close, store } = createProviderStore();
    addAndRead(store, "sk-or-secret", {
      accountId: "provider-account",
      label: "Work key",
    });
    expect(store.read("another-user", CREDENTIAL_ID)).toBeUndefined();
    expect(
      store.updateSecret(
        TEST_USER_ID,
        CREDENTIAL_ID,
        "rotated-secret",
        TEST_NOW + 1,
      ),
    ).toBe(true);
    expect(store.readSecret(TEST_USER_ID, CREDENTIAL_ID)).toBe(
      "rotated-secret",
    );
    store.remove(TEST_USER_ID, CREDENTIAL_ID, TEST_NOW + 1);
    expect(store.read(TEST_USER_ID, CREDENTIAL_ID)).toBeUndefined();
    close();
  });

  test("applies the scope schema on a legacy database", () => {
    const { close, store } = createProviderStore({ legacySchema: true });
    addAndRead(store, "sk-or-legacy-secret", {
      accountId: "legacy-account",
      label: "Legacy key",
    });
    close();
  });
});
