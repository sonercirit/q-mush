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

function createProviderStore(): {
  readonly close: () => void;
  readonly store: ProviderCredentialStore;
} {
  const database = createDatabase(":memory:");
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

describe("provider credential agent access", () => {
  test("reads an owned active credential with its metadata and secret", () => {
    const { close, store } = createProviderStore();
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
});
