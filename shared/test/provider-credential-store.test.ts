import { describe, expect, expectTypeOf, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import {
  createCredentialCipher,
  fingerprintProviderCredential,
} from "../../shared/credential-cipher.ts";
import { createDatabase } from "../../shared/database.ts";
import { providerCredentials, users } from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import {
  createDuplicateProviderCredentialError,
  isDuplicateProviderCredentialError,
  ProviderCredentialStore,
  type ProviderCredentialAccess,
} from "../../shared/provider-credential-store.ts";
import { hasTestDatabaseTable } from "./database-fixtures.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000051";
const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000052";
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";

// The migration battery covers from-scratch, legacy, and current-schema
// databases; this store test additionally exercises the legacy shape where
// credential-scope objects do not exist yet.
function ensureCredentialScopeSchema(
  database: ReturnType<typeof createDatabase>,
): void {
  const client = database.$client;
  if (!hasTestDatabaseTable(database, "workspaces")) {
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
  if (!hasTestDatabaseTable(database, "provider_credential_workspaces")) {
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
  readonly database: ReturnType<typeof createDatabase>;
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
  const cipher = createCredentialCipher(
    Buffer.from(new Uint8Array(32)).toString("base64url"),
    "Credential encryption key",
    () => new Uint8Array(12),
  );
  const ids = [CREDENTIAL_ID, SECOND_CREDENTIAL_ID];
  return {
    close: () => {
      database.$client.close();
    },
    database,
    store: new ProviderCredentialStore(
      database,
      cipher,
      "openrouter",
      () => ids.shift() ?? SECOND_CREDENTIAL_ID,
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

const ENDPOINT = {
  accountId: null,
  baseUrl: "https://gateway.example.test/v1",
  label: "Gateway",
} as const;

function addEndpointCredential(
  store: ProviderCredentialStore,
  secret: string,
  label: string,
): void {
  store.add(
    TEST_USER_ID,
    secret,
    { ...ENDPOINT, label },
    "api_key",
    TEST_NOW + 1,
  );
}

function createFirstCredential(store: ProviderCredentialStore): void {
  store.add(TEST_USER_ID, "first-secret", ENDPOINT, "api_key", TEST_NOW);
}

function addCredentialPair(
  store: ProviderCredentialStore,
  siblingSecret: string,
  siblingLabel: string,
): void {
  createFirstCredential(store);
  addEndpointCredential(store, siblingSecret, siblingLabel);
}

function createCollisionSetup(
  siblingSecret: string,
  siblingLabel: string,
): ReturnType<typeof createProviderStore> {
  const setup = createProviderStore();
  addCredentialPair(setup.store, siblingSecret, siblingLabel);
  return setup;
}

function expectRotationCollision(
  store: ProviderCredentialStore,
  secret: string,
  now: number,
): void {
  try {
    store.updateSecret(TEST_USER_ID, CREDENTIAL_ID, secret, now);
    throw new Error("The colliding credential rotation was accepted");
  } catch (error) {
    expect(isDuplicateProviderCredentialError(error)).toBe(true);
  }
  expect(store.readSecret(TEST_USER_ID, CREDENTIAL_ID)).toBe("first-secret");
}

function rotateSecret(store: ProviderCredentialStore, secret: string): void {
  expect(
    store.updateSecret(TEST_USER_ID, CREDENTIAL_ID, secret, TEST_NOW + 1),
  ).toBe(true);
}

describe("provider credential agent access", () => {
  test("identifies tagged duplicate credential errors", () => {
    expect(
      isDuplicateProviderCredentialError(
        createDuplicateProviderCredentialError(),
      ),
    ).toBe(true);
  });

  test("keeps the storage fingerprint off the broad secret-bearing type", () => {
    type HasFingerprint =
      "credentialFingerprint" extends keyof ProviderCredentialAccess
        ? true
        : false;
    expectTypeOf<HasFingerprint>().toEqualTypeOf<false>();
  });
  test("reads an owned active credential with its metadata and secret", () => {
    const { close, store } = createProviderStore();
    addAndRead(store, "sk-or-secret", {
      accountId: "provider-account",
      label: "Work key",
    });
    expect(store.read("another-user", CREDENTIAL_ID)).toBeUndefined();
    rotateSecret(store, "rotated-secret");
    expect(store.readSecret(TEST_USER_ID, CREDENTIAL_ID)).toBe(
      "rotated-secret",
    );
    store.remove(TEST_USER_ID, CREDENTIAL_ID, TEST_NOW + 1);
    expect(store.read(TEST_USER_ID, CREDENTIAL_ID)).toBeUndefined();
    close();
  });

  test("preserves generic endpoint identity when rotating a secret", () => {
    const { close, database, store } = createProviderStore();
    const endpoint = {
      accountId: null,
      apiFormat: "anthropic" as const,
      baseUrl: "https://anthropic.example.test/v1",
      label: "Claude proxy",
    };
    store.add(TEST_USER_ID, "original-secret", endpoint, "api_key", TEST_NOW);

    rotateSecret(store, "rotated-secret");
    expect(store.read(TEST_USER_ID, CREDENTIAL_ID)).toMatchObject({
      apiFormat: endpoint.apiFormat,
      baseUrl: endpoint.baseUrl,
      secret: "rotated-secret",
    });
    const stored = database
      .select({
        fingerprint: providerCredentials.credentialFingerprint,
        id: providerCredentials.id,
      })
      .from(providerCredentials)
      .all()
      .find(({ id }) => id === CREDENTIAL_ID);
    expect(stored?.fingerprint).toBe(
      fingerprintProviderCredential("rotated-secret", endpoint),
    );
    close();
  });

  test("rejects a secret rotation that collides with a sibling identity", () => {
    const { close, store } = createCollisionSetup("sibling-secret", "Sibling");

    expectRotationCollision(store, "sibling-secret", TEST_NOW + 2);
    expect(store.readSecret(TEST_USER_ID, SECOND_CREDENTIAL_ID)).toBe(
      "sibling-secret",
    );
    close();
  });

  test("rejects a secret rotation colliding with a soft-deleted identity", () => {
    const { close, store } = createCollisionSetup("retired-secret", "Retired");
    expect(store.remove(TEST_USER_ID, SECOND_CREDENTIAL_ID, TEST_NOW + 2)).toBe(
      true,
    );

    expectRotationCollision(store, "retired-secret", TEST_NOW + 3);
    expect(
      store.updateSecret(
        TEST_USER_ID,
        "missing-credential",
        "unused-secret",
        TEST_NOW + 4,
      ),
    ).toBe(false);
    close();
  });

  test("propagates non-collision errors during secret rotation", () => {
    const { close, database, store } = createProviderStore();
    createFirstCredential(store);
    const storageFailure = new Error("credential storage unavailable");
    const originalUpdate = database.update.bind(database);
    database.update = () => {
      throw storageFailure;
    };

    expect(() =>
      store.updateSecret(
        TEST_USER_ID,
        CREDENTIAL_ID,
        "rotated-secret",
        TEST_NOW + 1,
      ),
    ).toThrow(storageFailure);

    database.update = originalUpdate;
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
