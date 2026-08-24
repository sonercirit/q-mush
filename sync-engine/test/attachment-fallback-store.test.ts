import { describe, expect, test } from "vitest";
import {
  readAttachmentFallbackSelection,
  type AttachmentFallbackSelection,
} from "../../shared/attachment-fallback.ts";
import { createDatabase } from "../../shared/database.ts";
import { providerCredentials, users } from "../../shared/database/schema.ts";
import { hasTestDatabaseTable } from "../../shared/test/database-fixtures.ts";
import { createAttachmentFallbackStore } from "../attachment-fallback-store.ts";
import { testDatabaseColumns } from "./test-database-columns.ts";

const SELECTION: AttachmentFallbackSelection = {
  credentialId: "credential-1",
  modality: "image",
  model: "vision/model",
  openRouterProviderTag: null,
  provider: "openai",
};

function setup() {
  const database = createDatabase(":memory:");
  const now = new Date(1);
  database
    .insert(users)
    .values({
      createdAt: now,
      createdById: "user-1",
      email: "person@example.com",
      googleSubject: "google-1",
      id: "user-1",
      isDeleted: false,
      name: "Person",
      updatedAt: now,
      updatedById: "user-1",
    })
    .run();
  database
    .insert(providerCredentials)
    .values({
      createdAt: now,
      createdById: "user-1",
      credentialFingerprint: "fingerprint",
      encryptedCredential: "encrypted",
      id: "credential-1",
      isDefault: true,
      isDeleted: false,
      isGlobal: true,
      label: "OpenAI",
      provider: "openai",
      source: "api_key",
      updatedAt: now,
      updatedById: "user-1",
      userId: "user-1",
    })
    .run();
  if (!hasTestDatabaseTable(database, "attachment_fallbacks")) {
    database.$client.run(`
      CREATE TABLE attachment_fallbacks (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id),
        modality text NOT NULL,
        provider_credential_id text NOT NULL REFERENCES provider_credentials(id),
        provider text NOT NULL,
        model text NOT NULL,
        openrouter_provider_tag text,
        created_at integer NOT NULL,
        created_by_id text NOT NULL,
        updated_at integer NOT NULL,
        updated_by_id text NOT NULL,
        is_deleted integer NOT NULL DEFAULT false
      )
    `);
  } else {
    const columns = testDatabaseColumns(database, "attachment_fallbacks");
    if (columns.every(({ name }) => name !== "openrouter_provider_tag")) {
      database.$client.run(
        "ALTER TABLE attachment_fallbacks ADD COLUMN openrouter_provider_tag text",
      );
    }
  }
  return {
    database,
    store: createAttachmentFallbackStore(database, () => "fallback-1"),
  };
}

describe("attachment fallback store", () => {
  test("accepts serving-provider selection without a global prompt", () => {
    expect(
      readAttachmentFallbackSelection({
        ...SELECTION,
        openRouterProviderTag: "together",
        provider: "openrouter",
      }),
    ).toMatchObject({ openRouterProviderTag: "together" });
    expect(
      readAttachmentFallbackSelection({ ...SELECTION, prompt: "legacy" }),
    ).toBeUndefined();
  });

  test("persists one user-configurable fallback model per modality", () => {
    const { database, store } = setup();
    store.set("user-1", SELECTION, 2);

    expect(store.list("user-1")).toEqual([SELECTION]);
    database.$client.close();
  });
});
