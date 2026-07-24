import { expect, test } from "vitest";
import { createDatabase } from "../../shared/database.ts";
import { sessions, users, workspaces } from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import { DrizzleAuthStore } from "../../sync-engine/auth-store.ts";

const CREATED_AT = 1_700_000_000_000;
const PROFILE_UPDATED_AT = CREATED_AT + 50;
const FIRST_SESSION_EXPIRES_AT = CREATED_AT + 100;
const SECOND_SESSION_EXPIRES_AT = CREATED_AT + 1000;
const WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000010";
const USER_ID = "018bcfe5-6800-7000-8000-000000000011";
const FIRST_SESSION_ID = "018bcfe5-6800-7000-8000-000000000012";
const SECOND_SESSION_ID = "018bcfe5-6832-7000-8000-000000000013";

function createIdGenerator(): (timestamp: number) => string {
  const expectedIds = [
    { id: USER_ID, timestamp: CREATED_AT },
    { id: WORKSPACE_ID, timestamp: CREATED_AT },
    { id: FIRST_SESSION_ID, timestamp: CREATED_AT },
    { id: SECOND_SESSION_ID, timestamp: PROFILE_UPDATED_AT },
  ];

  return (timestamp) => {
    const expected = expectedIds.shift();

    if (expected?.timestamp !== timestamp) {
      throw new Error("Unexpected UUIDv7 generation");
    }

    return expected.id;
  };
}

test("audits profile updates and soft-deletes expired sessions", () => {
  const database = createDatabase(":memory:");
  const store = new DrizzleAuthStore(database, createIdGenerator());

  store.createSession(
    "first-token",
    {
      email: "before@example.com",
      googleSubject: "google-subject",
      name: "Before",
      picture: "https://example.com/before.png",
    },
    FIRST_SESSION_EXPIRES_AT,
    CREATED_AT,
  );
  store.createSession(
    "second-token",
    {
      email: "after@example.com",
      googleSubject: "google-subject",
      name: "After",
    },
    SECOND_SESSION_EXPIRES_AT,
    PROFILE_UPDATED_AT,
  );
  store.expireSessions(FIRST_SESSION_EXPIRES_AT);

  expect(database.select().from(users).all()).toEqual([
    {
      createdAt: new Date(CREATED_AT),
      createdById: SYSTEM_ID,
      email: "after@example.com",
      googleSubject: "google-subject",
      id: USER_ID,
      isDeleted: false,
      name: "After",
      picture: null,
      updatedAt: new Date(PROFILE_UPDATED_AT),
      updatedById: SYSTEM_ID,
    },
  ]);

  expect(database.select().from(workspaces).all()).toEqual([
    {
      createdAt: new Date(CREATED_AT),
      createdById: USER_ID,
      id: WORKSPACE_ID,
      isDefault: true,
      isDeleted: false,
      name: "Default",
      updatedAt: new Date(CREATED_AT),
      updatedById: USER_ID,
      userId: USER_ID,
    },
  ]);

  const storedSessions = database.select().from(sessions).all();
  const firstSession = storedSessions.find(
    ({ token }) => token === "first-token",
  );
  const secondSession = storedSessions.find(
    ({ token }) => token === "second-token",
  );

  expect(firstSession).toEqual({
    createdAt: new Date(CREATED_AT),
    createdById: USER_ID,
    expiresAt: new Date(FIRST_SESSION_EXPIRES_AT),
    id: FIRST_SESSION_ID,
    isDeleted: true,
    token: "first-token",
    updatedAt: new Date(FIRST_SESSION_EXPIRES_AT),
    updatedById: SYSTEM_ID,
    userId: USER_ID,
  });
  expect(secondSession).toEqual({
    createdAt: new Date(PROFILE_UPDATED_AT),
    createdById: USER_ID,
    expiresAt: new Date(SECOND_SESSION_EXPIRES_AT),
    id: SECOND_SESSION_ID,
    isDeleted: false,
    token: "second-token",
    updatedAt: new Date(PROFILE_UPDATED_AT),
    updatedById: USER_ID,
    userId: USER_ID,
  });
  expect(storedSessions).toHaveLength(2);
  expect(
    store.readSessionUser("first-token", FIRST_SESSION_EXPIRES_AT),
  ).toBeNull();
  expect(
    store.readSessionUser("second-token", FIRST_SESSION_EXPIRES_AT),
  ).toEqual({
    email: "after@example.com",
    id: USER_ID,
    name: "After",
  });

  database.$client.close();
});
