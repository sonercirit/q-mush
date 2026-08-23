import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { prompts } from "../../shared/database/schema.ts";
import { PromptStore } from "../../sync-engine/prompt-store.ts";
import {
  addTestUser,
  createAuthenticatedTestDatabase,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const FIRST_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000061";
const SECOND_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000062";
const OTHER_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000063";
const DUPLICATE_ATTEMPT_ID = "018bcfe5-6800-7000-8000-000000000064";

function storedPrompt(
  database: ReturnType<typeof createAuthenticatedTestDatabase>,
  id: string,
) {
  return database.query.prompts.findFirst({ where: eq(prompts.id, id) }).sync();
}

function createStore() {
  const database = createAuthenticatedTestDatabase();
  addTestUser(database);
  const ids = [
    FIRST_PROMPT_ID,
    SECOND_PROMPT_ID,
    OTHER_PROMPT_ID,
    DUPLICATE_ATTEMPT_ID,
  ];
  return {
    database,
    store: new PromptStore(database, () =>
      takeValue(ids, "The test ran out of prompt IDs"),
    ),
  };
}

function promptStoreTest(
  action: (configured: ReturnType<typeof createStore>) => void,
): void {
  const configured = createStore();
  try {
    action(configured);
  } finally {
    configured.database.$client.close();
  }
}

function namedPromptStoreTest(
  name: string,
  action: (configured: ReturnType<typeof createStore>) => void,
): void {
  test(name, () => {
    promptStoreTest(action);
  });
}

function createPrompt(
  store: PromptStore,
  userId: string,
  name: string,
  body: string,
  now: number,
) {
  return store.create(userId, { body, name }, now);
}

function createOwnerPrompt(
  store: PromptStore,
  name: string,
  body: string,
  now = TEST_NOW,
) {
  return createPrompt(store, TEST_USER_ID, name, body, now);
}

function updatePrompt(
  store: PromptStore,
  id: string,
  body: string,
  now: number,
  revision: number,
) {
  return store.update(TEST_USER_ID, id, { body, name: "First" }, now, revision);
}

function expectPromptChanged(action: () => unknown): void {
  expect(() => action()).toThrow(
    expect.objectContaining({ kind: "prompt_changed" }),
  );
}

describe("prompt store", () => {
  namedPromptStoreTest(
    "persists owner audit fields and increments revisions",
    ({ database, store }) => {
      const first = createOwnerPrompt(
        store,
        "Review",
        "Review the current changes.",
      );
      const second = createPrompt(
        store,
        TEST_USER_ID,
        "Tests",
        "Write focused tests.",
        TEST_NOW + 1,
      );
      const updated = store.update(
        TEST_USER_ID,
        second.id,
        { body: "Write only focused tests.", name: "Focused tests" },
        TEST_NOW + 2,
        second.revision,
      );

      expect(first).toEqual({
        body: "Review the current changes.",
        createdAt: TEST_NOW,
        id: FIRST_PROMPT_ID,
        name: "Review",
        revision: 1,
        updatedAt: TEST_NOW,
      });
      expect(store.list(TEST_USER_ID)).toEqual([first, updated]);
      expect(updated).toMatchObject({ revision: 2, updatedAt: TEST_NOW + 2 });
      expect(storedPrompt(database, SECOND_PROMPT_ID)).toMatchObject({
        createdById: TEST_USER_ID,
        updatedById: TEST_USER_ID,
        userId: TEST_USER_ID,
      });
    },
  );

  namedPromptStoreTest(
    "scopes active names to owners and reuses names after soft deletion",
    ({ database, store }) => {
      const first = createOwnerPrompt(
        store,
        "Ｒｅｌｅａｓｅ checklist",
        "First body",
      );
      createPrompt(store, TEST_USER_ID, "Tests", "Second body", TEST_NOW + 1);
      const other = createPrompt(
        store,
        TEST_FOREIGN_USER_ID,
        "release checklist",
        "Private body",
        TEST_NOW + 2,
      );

      expect(() =>
        store.create(
          TEST_USER_ID,
          { body: "Duplicate", name: "RELEASE  CHECKLIST" },
          TEST_NOW + 3,
        ),
      ).toThrow(expect.objectContaining({ kind: "duplicate_prompt_name" }));
      expect(store.get(TEST_USER_ID, OTHER_PROMPT_ID)).toBeUndefined();
      expect(store.get(TEST_FOREIGN_USER_ID, OTHER_PROMPT_ID)).toEqual(other);
      expect(store.remove(TEST_USER_ID, OTHER_PROMPT_ID, TEST_NOW + 4, 1)).toBe(
        false,
      );

      expect(store.remove(TEST_USER_ID, first.id, TEST_NOW + 5, 1)).toBe(true);
      expect(storedPrompt(database, first.id)).toMatchObject({
        isDeleted: true,
        revision: 2,
        updatedById: TEST_USER_ID,
      });
      const reused = store.create(
        TEST_USER_ID,
        { body: "Replacement", name: "Release checklist" },
        TEST_NOW + 6,
      );
      expect(reused.id).toBe(DUPLICATE_ATTEMPT_ID);
    },
  );

  namedPromptStoreTest(
    "rejects stale writes and caps each owner's active prompts",
    ({ database, store }) => {
      const first = createOwnerPrompt(store, "First", "Original body");
      store.update(
        TEST_USER_ID,
        first.id,
        { body: "Current body", name: "First" },
        TEST_NOW + 1,
        first.revision,
      );
      expectPromptChanged(() =>
        updatePrompt(
          store,
          first.id,
          "Stale body",
          TEST_NOW + 2,
          first.revision,
        ),
      );
      expectPromptChanged(() =>
        store.remove(TEST_USER_ID, first.id, TEST_NOW + 3, first.revision),
      );

      const limited = new PromptStore(database, () => SECOND_PROMPT_ID, 1);
      expect(() =>
        limited.create(
          TEST_USER_ID,
          { body: "Over limit", name: "Second" },
          TEST_NOW + 4,
        ),
      ).toThrow(expect.objectContaining({ kind: "prompt_limit" }));
      expect(
        limited.create(
          TEST_FOREIGN_USER_ID,
          { body: "Independent", name: "Second" },
          TEST_NOW + 5,
        ).id,
      ).toBe(SECOND_PROMPT_ID);

      expect(store.remove(TEST_USER_ID, first.id, TEST_NOW + 6, 2)).toBe(true);
      expectPromptChanged(() =>
        updatePrompt(store, first.id, "Late body", TEST_NOW + 7, 2),
      );
    },
  );
});
