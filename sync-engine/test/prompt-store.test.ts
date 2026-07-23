import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { prompts } from "../../shared/database/schema.ts";
import {
  DuplicatePromptNameError,
  PromptStore,
} from "../../sync-engine/prompt-store.ts";
import {
  addOtherTestUser,
  createAuthenticatedTestDatabase,
  OTHER_TEST_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createValueSequence } from "./oauth-test-helpers.ts";

const FIRST_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000061";
const SECOND_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000062";
const OTHER_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000063";
const REUSED_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000066";
const OTHER_USER_ID = OTHER_TEST_USER_ID;
const DUPLICATE_ATTEMPT_ID = "018bcfe5-6800-7000-8000-000000000064";

function storedPrompt(
  database: ReturnType<typeof createAuthenticatedTestDatabase>,
  id: string,
) {
  return database.query.prompts
    .findFirst({
      where: eq(prompts.id, id),
    })
    .sync();
}

function createStore() {
  const database = createAuthenticatedTestDatabase();
  addOtherTestUser(database);
  const generateId = createValueSequence(
    [
      FIRST_PROMPT_ID,
      SECOND_PROMPT_ID,
      OTHER_PROMPT_ID,
      DUPLICATE_ATTEMPT_ID,
      REUSED_PROMPT_ID,
    ],
    "The test ran out of prompt IDs",
  );
  return {
    database,
    store: new PromptStore(database, generateId),
  };
}

describe("prompt store", () => {
  test("persists UUIDv7 prompts with user audit fields", () => {
    const { database, store } = createStore();
    const created = store.create(
      TEST_USER_ID,
      { body: "Review the current changes.", name: "Review" },
      TEST_NOW,
    );
    const second = store.create(
      TEST_USER_ID,
      { body: "Write focused tests.", name: "Tests" },
      TEST_NOW + 1,
    );

    expect(created).toEqual({
      body: "Review the current changes.",
      createdAt: TEST_NOW,
      id: FIRST_PROMPT_ID,
      name: "Review",
      updatedAt: TEST_NOW,
    });
    expect(store.list(TEST_USER_ID)).toEqual([created, second]);
    const updated = store.update(
      TEST_USER_ID,
      SECOND_PROMPT_ID,
      { body: "Write only focused tests.", name: "Focused tests" },
      TEST_NOW + 2,
    );
    expect(updated).toEqual({
      ...second,
      body: "Write only focused tests.",
      name: "Focused tests",
      updatedAt: TEST_NOW + 2,
    });
    expect(storedPrompt(database, SECOND_PROMPT_ID)).toMatchObject({
      body: "Write only focused tests.",
      name: "Focused tests",
      updatedById: TEST_USER_ID,
    });

    const stored = storedPrompt(database, FIRST_PROMPT_ID);
    expect(stored).toMatchObject({
      body: created.body,
      createdById: TEST_USER_ID,
      id: FIRST_PROMPT_ID,
      isDeleted: false,
      name: created.name,
      userId: TEST_USER_ID,
      updatedById: TEST_USER_ID,
    });
    expect(stored?.createdAt.getTime()).toBe(TEST_NOW);
    expect(stored?.updatedAt.getTime()).toBe(TEST_NOW);
    database.$client.close();
  });

  test("enforces private, normalized active names and soft deletion", () => {
    const { database, store } = createStore();
    store.create(
      TEST_USER_ID,
      { body: "First body", name: "Ｒｅｌｅａｓｅ checklist" },
      TEST_NOW,
    );
    store.create(
      TEST_USER_ID,
      { body: "Second body", name: "Tests" },
      TEST_NOW + 1,
    );
    const other = store.create(
      OTHER_USER_ID,
      { body: "Private body", name: "release checklist" },
      TEST_NOW + 2,
    );

    expect(() =>
      store.create(
        TEST_USER_ID,
        { body: "Duplicate", name: "RELEASE CHECKLIST" },
        TEST_NOW + 3,
      ),
    ).toThrow(DuplicatePromptNameError);
    expect(store.get(TEST_USER_ID, OTHER_PROMPT_ID)).toBeUndefined();
    expect(store.get(OTHER_USER_ID, OTHER_PROMPT_ID)).toEqual(other);
    expect(
      store.update(
        TEST_USER_ID,
        OTHER_PROMPT_ID,
        { body: "Stolen", name: "Stolen" },
        TEST_NOW + 4,
      ),
    ).toBeUndefined();
    expect(store.remove(TEST_USER_ID, OTHER_PROMPT_ID, TEST_NOW + 5)).toBe(
      false,
    );
    expect(() =>
      store.update(
        TEST_USER_ID,
        SECOND_PROMPT_ID,
        { body: "Duplicate", name: "release checklist" },
        TEST_NOW + 6,
      ),
    ).toThrow(DuplicatePromptNameError);

    expect(store.remove(TEST_USER_ID, FIRST_PROMPT_ID, TEST_NOW + 7)).toBe(
      true,
    );
    expect(store.get(TEST_USER_ID, FIRST_PROMPT_ID)).toBeUndefined();
    expect(store.list(TEST_USER_ID).map(({ id }) => id)).toEqual([
      SECOND_PROMPT_ID,
    ]);
    const removed = storedPrompt(database, FIRST_PROMPT_ID);
    expect(removed).toMatchObject({
      isDeleted: true,
      updatedById: TEST_USER_ID,
    });
    expect(removed?.updatedAt.getTime()).toBe(TEST_NOW + 7);

    const reused = store.create(
      TEST_USER_ID,
      { body: "Replacement", name: "Release checklist" },
      TEST_NOW + 8,
    );
    expect(reused.id).toBe(REUSED_PROMPT_ID);
    expect(database.select().from(prompts).all()).toHaveLength(4);
    database.$client.close();
  });
});
