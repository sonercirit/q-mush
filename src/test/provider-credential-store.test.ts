import { describe, expect, test } from "bun:test";
import { CredentialCipher } from "../credential-cipher.ts";
import { ProviderCredentialStore } from "../provider-credential-store.ts";
import {
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000051";

describe("provider credential agent access", () => {
  test("reads an owned active credential with its metadata and secret", () => {
    const database = createAuthenticatedTestDatabase();
    const cipher = new CredentialCipher(
      new Uint8Array(32),
      () => new Uint8Array(12),
    );
    const store = new ProviderCredentialStore(
      database,
      cipher,
      "openrouter",
      () => CREDENTIAL_ID,
    );
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
    ).toBeTrue();
    expect(store.readSecret(TEST_USER_ID, CREDENTIAL_ID)).toBe(
      "rotated-secret",
    );
    store.remove(TEST_USER_ID, CREDENTIAL_ID, TEST_NOW + 1);
    expect(store.read(TEST_USER_ID, CREDENTIAL_ID)).toBeUndefined();
    database.$client.close();
  });
});
