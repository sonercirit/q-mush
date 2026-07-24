import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { CredentialCipher } from "../../shared/credential-cipher.ts";
import { createDatabase } from "../../shared/database.ts";
import {
  providerCredentials,
  providerCredentialWorkspaces,
  users,
  workspaces,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import { ProviderCredentialStore } from "../../shared/provider-credential-store.ts";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000051";
const FIRST_SCOPE_ID = "018bcfe5-6800-7000-8000-000000000052";
const SECOND_SCOPE_ID = "018bcfe5-6800-7000-8000-000000000053";
const FIRST_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000054";
const SECOND_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000055";
const OTHER_USER_ID = "018bcfe5-6800-7000-8000-000000000056";
const OTHER_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000057";
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";

function createProviderStore() {
  const database = createDatabase(":memory:");
  const user = {
    ...createdAuditFields(SYSTEM_ID, TEST_NOW),
    email: "mushroom@example.com",
    googleSubject: "google-user",
    id: TEST_USER_ID,
    name: "Mush Room",
  };
  database.insert(users).values(user).run();
  database
    .insert(users)
    .values({
      ...user,
      email: "other@example.com",
      googleSubject: "other-google-user",
      id: OTHER_USER_ID,
    })
    .run();
  database
    .insert(workspaces)
    .values([
      {
        ...createdAuditFields(TEST_USER_ID, TEST_NOW),
        id: FIRST_WORKSPACE_ID,
        isDefault: true,
        name: "Default",
        userId: TEST_USER_ID,
      },
      {
        ...createdAuditFields(TEST_USER_ID, TEST_NOW),
        id: SECOND_WORKSPACE_ID,
        name: "Projects",
        userId: TEST_USER_ID,
      },
      {
        ...createdAuditFields(OTHER_USER_ID, TEST_NOW),
        id: OTHER_WORKSPACE_ID,
        isDefault: true,
        name: "Default",
        userId: OTHER_USER_ID,
      },
    ])
    .run();
  const cipher = new CredentialCipher(
    new Uint8Array(32),
    () => new Uint8Array(12),
  );
  const ids = [CREDENTIAL_ID, FIRST_SCOPE_ID, SECOND_SCOPE_ID];
  return {
    database,
    store: new ProviderCredentialStore(database, cipher, "openrouter", () => {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The test ran out of credential IDs");
      }
      return id;
    }),
  };
}

describe("provider credential agent access", () => {
  test("reads an owned active credential with its metadata and secret", () => {
    const { database, store } = createProviderStore();
    store.add(
      TEST_USER_ID,
      "sk-or-secret",
      { accountId: "provider-account", label: "Work key" },
      "api_key",
      TEST_NOW,
    );

    expect(store.read(TEST_USER_ID, CREDENTIAL_ID)).toEqual({
      accountId: "provider-account",
      id: CREDENTIAL_ID,
      label: "Work key",
      isDefault: false,
      secret: "sk-or-secret",
      source: "api_key",
    });
    expect(store.read(OTHER_USER_ID, CREDENTIAL_ID)).toBeUndefined();
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
    database.$client.close();
  });

  test("enforces Global and multi-workspace scopes without exposing secrets", () => {
    const { database, store } = createProviderStore();
    const global = store.add(
      TEST_USER_ID,
      "sk-global-secret",
      { accountId: "provider-account", label: "Global key" },
      "api_key",
      TEST_NOW,
    );

    expect(global).toMatchObject({ isGlobal: true, workspaceIds: [] });
    expect(
      store.read(TEST_USER_ID, CREDENTIAL_ID, FIRST_WORKSPACE_ID),
    ).toMatchObject({ secret: "sk-global-secret" });
    expect(
      store.read(TEST_USER_ID, CREDENTIAL_ID, SECOND_WORKSPACE_ID),
    ).toMatchObject({ secret: "sk-global-secret" });
    expect(
      store.read(TEST_USER_ID, CREDENTIAL_ID, OTHER_WORKSPACE_ID),
    ).toBeUndefined();
    expect(store.list(TEST_USER_ID, OTHER_WORKSPACE_ID)).toEqual([]);
    expect(
      JSON.stringify(store.list(TEST_USER_ID, FIRST_WORKSPACE_ID)),
    ).not.toContain("secret");

    expect(
      store.setScopes(
        TEST_USER_ID,
        CREDENTIAL_ID,
        [FIRST_WORKSPACE_ID, SECOND_WORKSPACE_ID],
        TEST_NOW + 1,
      ),
    ).toBe(true);
    expect(
      store.read(TEST_USER_ID, CREDENTIAL_ID, FIRST_WORKSPACE_ID),
    ).toMatchObject({
      isGlobal: false,
      workspaceIds: [FIRST_WORKSPACE_ID, SECOND_WORKSPACE_ID],
    });
    expect(
      store.read(TEST_USER_ID, CREDENTIAL_ID, SECOND_WORKSPACE_ID),
    ).toBeDefined();
    expect(
      store.read(TEST_USER_ID, CREDENTIAL_ID, GLOBAL_WORKSPACE_ID),
    ).toBeUndefined();
    expect(
      database.select().from(providerCredentialWorkspaces).all(),
    ).toHaveLength(2);
    expect(
      database
        .select({ isGlobal: providerCredentials.isGlobal })
        .from(providerCredentials)
        .get(),
    ).toEqual({ isGlobal: false });

    expect(() =>
      store.setScopes(
        TEST_USER_ID,
        CREDENTIAL_ID,
        [OTHER_WORKSPACE_ID],
        TEST_NOW + 2,
      ),
    ).toThrow("unavailable");
    expect(() =>
      store.setScopes(
        TEST_USER_ID,
        CREDENTIAL_ID,
        [FIRST_WORKSPACE_ID, FIRST_WORKSPACE_ID],
        TEST_NOW + 2,
      ),
    ).toThrow("invalid");
    expect(
      store.setScopes(
        OTHER_USER_ID,
        CREDENTIAL_ID,
        [OTHER_WORKSPACE_ID],
        TEST_NOW + 2,
      ),
    ).toBe(false);
    database.$client.close();
  });
});
