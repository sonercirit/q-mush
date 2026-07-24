import { describe, expect, test } from "vitest";
import {
  createdAuditFields,
  softDeletedAuditFields,
} from "../../shared/audit.ts";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import {
  agentSessions,
  providerCredentials,
  runners,
  users,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type { AgentSessionStatus } from "../../shared/session-model.ts";
import { SessionCredentialReassignmentStore } from "../../sync-engine/session-credential-reassignment-store.ts";

const NOW = 1_700_000_000_000;
const MIGRATED_AT = NOW + 10_000;
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const RUNNER_ID = "runner-1";
const OTHER_RUNNER_ID = "runner-2";
const OPENAI_SOURCE = "openai-source";
const OPENAI_TARGET = "openai-target";
const OPENROUTER_SOURCE = "openrouter-source";
const OPENROUTER_TARGET = "openrouter-target";
const STATUSES: readonly AgentSessionStatus[] = [
  "queued",
  "running",
  "idle",
  "stopped",
  "failed",
];

function insertUser(database: AppDatabase, id: string): void {
  database
    .insert(users)
    .values({
      ...createdAuditFields(SYSTEM_ID, NOW),
      email: `${id}@example.test`,
      googleSubject: `google-${id}`,
      id,
      name: id,
    })
    .run();
}

function insertRunner(database: AppDatabase, id: string, userId: string): void {
  database
    .insert(runners)
    .values({
      ...createdAuditFields(userId, NOW),
      id,
      tokenHash: `hash-${id}`,
      userId,
    })
    .run();
}

function insertCredential(
  database: AppDatabase,
  id: string,
  userId: string,
  provider: "openai" | "openrouter",
  options: { readonly deleted?: boolean; readonly default?: boolean } = {},
): void {
  database
    .insert(providerCredentials)
    .values({
      ...createdAuditFields(userId, NOW),
      ...(options.deleted === true
        ? softDeletedAuditFields(userId, NOW + 1)
        : {}),
      credentialFingerprint: `fingerprint-${id}`,
      encryptedCredential: options.deleted === true ? "" : `encrypted-${id}`,
      id,
      isDefault: options.default ?? false,
      label: id,
      provider,
      source: id.includes("target") ? "oauth" : "api_key",
      userId,
    })
    .run();
}

interface SessionOptions {
  readonly deleted?: boolean;
  readonly parentSessionId?: string;
  readonly status?: AgentSessionStatus;
}

function insertSession(
  database: AppDatabase,
  id: string,
  userId: string,
  provider: "openai" | "openrouter",
  credentialId: string,
  options: SessionOptions = {},
): void {
  const actor = userId;
  database
    .insert(agentSessions)
    .values({
      ...createdAuditFields(actor, NOW),
      ...(options.deleted === true
        ? softDeletedAuditFields(actor, NOW + 1)
        : {}),
      activeDurationMs: 321,
      autoCompact: false,
      costBasis: "reported",
      costUsd: 1.25,
      currentContextTokens: 42,
      id,
      maxContextTokens: 128_000,
      model: `model-${id}`,
      parentSessionId: options.parentSessionId ?? null,
      provider,
      providerCredentialId: credentialId,
      providerPricing: JSON.stringify({ input: 1, output: 2 }),
      reasoningEffort: "high",
      runnerId: userId === USER_ID ? RUNNER_ID : OTHER_RUNNER_ID,
      status: options.status ?? "idle",
      title: `Title ${id}`,
      tools: JSON.stringify(["read"]),
      userId,
      workingDirectory: `/work/${id}`,
    })
    .run();
}

function insertSourceSessions(database: AppDatabase, ...ids: string[]): void {
  for (const id of ids) {
    insertSession(database, id, USER_ID, "openai", OPENAI_SOURCE);
  }
}

function setup(): {
  readonly database: AppDatabase;
  readonly store: SessionCredentialReassignmentStore;
} {
  const database = createDatabase(":memory:");
  insertUser(database, USER_ID);
  insertUser(database, OTHER_USER_ID);
  insertRunner(database, RUNNER_ID, USER_ID);
  insertRunner(database, OTHER_RUNNER_ID, OTHER_USER_ID);
  insertCredential(database, OPENAI_SOURCE, USER_ID, "openai", {
    default: true,
  });
  insertCredential(database, OPENAI_TARGET, USER_ID, "openai");
  insertCredential(database, OPENROUTER_SOURCE, USER_ID, "openrouter");
  insertCredential(database, OPENROUTER_TARGET, USER_ID, "openrouter");
  return {
    database,
    store: new SessionCredentialReassignmentStore(database),
  };
}

function storedSessions(database: AppDatabase) {
  return database.select().from(agentSessions).all();
}

function credentialDefaults(database: AppDatabase) {
  return database
    .select({
      id: providerCredentials.id,
      isDefault: providerCredentials.isDefault,
    })
    .from(providerCredentials)
    .all();
}

function findSession(
  sessions: readonly (typeof agentSessions.$inferSelect)[],
  id: string,
) {
  return sessions.find((session) => session.id === id);
}

function preserveSession(
  before: readonly (typeof agentSessions.$inferSelect)[],
  after: readonly (typeof agentSessions.$inferSelect)[],
  id: string,
): void {
  expect(findSession(after, id)).toEqual(findSession(before, id));
}

describe("session credential reassignment store", () => {
  test("migrates every status and parent or child for the exact provider only", () => {
    const { database, store } = setup();
    for (const [index, status] of STATUSES.entries()) {
      insertSession(
        database,
        `openai-${status}`,
        USER_ID,
        "openai",
        OPENAI_SOURCE,
        {
          ...(index === 0 ? {} : { parentSessionId: "openai-queued" }),
          status,
        },
      );
    }
    insertSession(
      database,
      "openrouter-session",
      USER_ID,
      "openrouter",
      OPENROUTER_SOURCE,
    );
    insertSession(
      database,
      "other-user-session",
      OTHER_USER_ID,
      "openai",
      (() => {
        insertCredential(database, "other-openai", OTHER_USER_ID, "openai");
        return "other-openai";
      })(),
    );
    insertSession(
      database,
      "deleted-session",
      USER_ID,
      "openai",
      OPENAI_SOURCE,
      { deleted: true },
    );
    insertSession(database, "already-target", USER_ID, "openai", OPENAI_TARGET);

    const before = storedSessions(database);
    const result = store.reassign(
      USER_ID,
      "openai",
      OPENAI_TARGET,
      MIGRATED_AT,
    );
    const after = storedSessions(database);

    expect(result).toEqual({ migratedSessionCount: STATUSES.length });
    for (const status of STATUSES) {
      expect(after.find(({ id }) => id === `openai-${status}`)).toMatchObject({
        provider: "openai",
        providerCredentialId: OPENAI_TARGET,
        status,
        updatedAt: new Date(MIGRATED_AT),
        updatedById: USER_ID,
      });
    }
    for (const id of [
      "openrouter-session",
      "other-user-session",
      "deleted-session",
      "already-target",
    ]) {
      preserveSession(before, after, id);
    }
    database.$client.close();
  });

  test("updates only credential and normal update audit fields without changing defaults", () => {
    const scenario = setup();
    const { database } = scenario;
    insertSession(
      database,
      "preserved-session",
      USER_ID,
      "openai",
      OPENAI_SOURCE,
      { parentSessionId: "historical-parent", status: "failed" },
    );
    const before = findSession(storedSessions(database), "preserved-session");
    const defaultsBefore = credentialDefaults(database);

    expect(
      scenario.store.reassign(USER_ID, "openai", OPENAI_TARGET, MIGRATED_AT),
    ).toEqual({ migratedSessionCount: 1 });
    const after = findSession(storedSessions(database), "preserved-session");

    expect(after).toEqual({
      ...before,
      providerCredentialId: OPENAI_TARGET,
      updatedAt: new Date(MIGRATED_AT),
      updatedById: USER_ID,
    });
    expect(credentialDefaults(database)).toEqual(defaultsBefore);
    expect(
      credentialDefaults(database).find(({ id }) => id === OPENAI_SOURCE),
    ).toEqual({ id: OPENAI_SOURCE, isDefault: true });
    database.$client.close();
  });

  test("is idempotent and permits the last committed same-provider target to win", () => {
    const { database, store } = setup();
    insertSession(database, "session", USER_ID, "openai", OPENAI_SOURCE);

    const migrate = (targetId: string, now: number) =>
      store.reassign(USER_ID, "openai", targetId, now);
    const changed = { migratedSessionCount: 1 };

    expect(migrate(OPENAI_TARGET, MIGRATED_AT)).toEqual(changed);
    expect(migrate(OPENAI_TARGET, MIGRATED_AT + 1)).toEqual({
      migratedSessionCount: 0,
    });
    expect(migrate(OPENAI_SOURCE, MIGRATED_AT + 2)).toEqual(changed);
    expect(findSession(storedSessions(database), "session")).toMatchObject({
      providerCredentialId: OPENAI_SOURCE,
      updatedAt: new Date(MIGRATED_AT + 2),
    });
    database.$client.close();
  });

  test("rejects missing, cross-provider, soft-deleted, and other-user targets atomically", () => {
    const { database, store } = setup();
    insertCredential(database, "deleted-target", USER_ID, "openai", {
      deleted: true,
    });
    insertCredential(database, "other-target", OTHER_USER_ID, "openai");
    insertSourceSessions(database, "session");
    const before = storedSessions(database);

    const reassign = (targetId: string) =>
      store.reassign(USER_ID, "openai", targetId, MIGRATED_AT);

    for (const target of [
      "missing",
      OPENROUTER_TARGET,
      "deleted-target",
      "other-target",
    ]) {
      expect(reassign(target)).toBeUndefined();
      expect(storedSessions(database)).toEqual(before);
    }
    database.$client.close();
  });

  test("rolls back the set-based update when SQLite rejects a row", () => {
    const { database, store } = setup();
    insertSourceSessions(database, "first", "second");
    database.$client.run(`
      CREATE TRIGGER fail_session_reassignment
      BEFORE UPDATE OF provider_credential_id ON agent_sessions
      WHEN OLD.id = 'second'
      BEGIN
        SELECT RAISE(ABORT, 'induced failure');
      END
    `);
    const before = storedSessions(database);

    expect(() =>
      store.reassign(USER_ID, "openai", OPENAI_TARGET, MIGRATED_AT),
    ).toThrow("induced failure");
    expect(storedSessions(database)).toEqual(before);
    database.$client.close();
  });
});
