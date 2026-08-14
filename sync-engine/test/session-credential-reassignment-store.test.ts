import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { type AppDatabase } from "../../shared/database.ts";
import {
  agentSessions,
  providerCredentials,
  providerCredentialWorkspaces,
  runners,
  users,
  workspaces,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import {
  DEFAULT_WORKSPACE_NAME,
  GLOBAL_WORKSPACE_ID,
} from "../../shared/workspace-model.ts";
import {
  SessionCredentialReassignmentStore,
  type SessionCredentialMetadataUpdate,
} from "../session-credential-reassignment-store.ts";
import { createSchemaCompatibleTestDatabase } from "./authenticated-integration-test-helpers.ts";
import { closeTrackedDatabases } from "./database-test-helpers.ts";
import {
  expectedOpenRouterSessionMetadata,
  openRouterSessionMetadataSelection,
} from "./openrouter-provider-catalog-fixture.ts";
import { testSessionCredentialMetadataUpdate } from "./session-credential-metadata-fixtures.ts";

const NOW = 1_700_000_000_000;
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const SOURCE = "source";
const TARGET = "target";
const databases: AppDatabase[] = [];

function setup(): {
  readonly database: AppDatabase;
  readonly store: SessionCredentialReassignmentStore;
} {
  const database = createSchemaCompatibleTestDatabase();
  databases.push(database);
  for (const id of [USER_ID, OTHER_USER_ID]) {
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
    database
      .insert(workspaces)
      .values({
        ...createdAuditFields(id, NOW),
        id: `workspace-${id}`,
        isDefault: true,
        name: DEFAULT_WORKSPACE_NAME,
        userId: id,
      })
      .run();
    database
      .insert(runners)
      .values({
        ...createdAuditFields(id, NOW),
        id: `runner-${id}`,
        tokenHash: `token-${id}`,
        userId: id,
      })
      .run();
  }
  for (const [id, provider, userId] of [
    [SOURCE, "openai", USER_ID],
    [TARGET, "openai", USER_ID],
    ["generic-source", "generic", USER_ID],
    ["generic-target", "generic", USER_ID],
    ["openrouter-source", "openrouter", USER_ID],
    ["openrouter-target", "openrouter", USER_ID],
    ["foreign-target", "openai", OTHER_USER_ID],
  ] as const) {
    database
      .insert(providerCredentials)
      .values({
        ...createdAuditFields(userId, NOW),
        credentialFingerprint: `fingerprint-${id}`,
        encryptedCredential: `encrypted-${id}`,
        id,
        isDefault: id === SOURCE,
        label: id,
        provider,
        source: "api_key",
        userId,
      })
      .run();
  }
  return { database, store: new SessionCredentialReassignmentStore(database) };
}

function addSession(
  database: AppDatabase,
  id: string,
  credentialId = SOURCE,
  options: {
    readonly adaptiveThinking?: boolean | null;
    readonly contextWindow?: number | null;
    readonly deleted?: boolean;
    readonly maxOutputTokens?: number | null;
    readonly model?: string;
    readonly openRouterProviderTag?: string | null;
    readonly pricing?: string | null;
    readonly provider?: "generic" | "openai" | "openrouter";
  } = {},
): void {
  database
    .insert(agentSessions)
    .values({
      ...createdAuditFields(USER_ID, NOW),
      ...(options.deleted === true ? { isDeleted: true } : {}),
      adaptiveThinking: options.adaptiveThinking,
      id,
      maxContextTokens: options.contextWindow,
      maxOutputTokens: options.maxOutputTokens,
      model: options.model ?? "test-model",
      openRouterProviderTag: options.openRouterProviderTag,
      provider: options.provider ?? "openai",
      providerCredentialId: credentialId,
      providerPricing: options.pricing,
      runnerId: `runner-${USER_ID}`,
      status: "idle",
      title: id,
      userId: USER_ID,
      workspaceId: `workspace-${USER_ID}`,
      workingDirectory: "/workspace",
    })
    .run();
}

function addOpenRouterSession(
  database: AppDatabase,
  overrides: NonNullable<Parameters<typeof addSession>[3]> = {},
): void {
  addSession(database, "session-1", "openrouter-target", {
    model: "vendor/model",
    openRouterProviderTag: "together",
    provider: "openrouter",
    ...overrides,
  });
}

function sessionCredential(
  database: AppDatabase,
  sessionId = "session-1",
): string | null | undefined {
  return openRouterSessionMetadata(database, sessionId)?.credentialId;
}

function openRouterSessionMetadata(
  database: AppDatabase,
  sessionId = "session-1",
) {
  return openRouterSessionMetadataSelection(database)
    .where(eq(agentSessions.id, sessionId))
    .get();
}

function reassign(
  store: SessionCredentialReassignmentStore,
  credentialId = TARGET,
) {
  return store.reassign({
    credentialId,
    now: NOW + 1,
    provider: "openai",
    userId: USER_ID,
  });
}

function expectMigratedSessionCount(
  result: ReturnType<typeof reassign>,
  migratedSessionCount: number,
): void {
  expect(result).toEqual({ migratedSessionCount });
}

function setupWithSession() {
  const configured = setup();
  addSession(configured.database, "session-1");
  return configured;
}

function openRouterSnapshot(store: SessionCredentialReassignmentStore) {
  const snapshot = store.snapshot({
    credentialId: "openrouter-source",
    provider: "openrouter",
    userId: USER_ID,
  });
  if (snapshot === undefined) {
    throw new Error("The reassignment snapshot was unavailable");
  }
  return snapshot;
}

function reassignOpenRouter(
  store: SessionCredentialReassignmentStore,
  snapshot: ReturnType<typeof openRouterSnapshot>,
  metadataUpdates: readonly SessionCredentialMetadataUpdate[] = [],
) {
  return store.reassign({
    credentialId: "openrouter-source",
    now: NOW + 1,
    preparedProviderState: {
      expectedSessions: snapshot.sessions,
      metadataUpdates,
    },
    provider: "openrouter",
    userId: USER_ID,
  });
}

afterEach(() => {
  closeTrackedDatabases(databases);
});

describe("session credential reassignment store", () => {
  test("validates same owner and provider inside an immediate transaction", () => {
    const { database, store } = setupWithSession();
    const transaction = vi.spyOn(database, "transaction");

    for (const credentialId of [
      "missing",
      "openrouter-target",
      "foreign-target",
    ]) {
      expect(reassign(store, credentialId)).toBeUndefined();
    }
    expect(reassign(store)).toEqual({ migratedSessionCount: 1 });
    expect(
      transaction.mock.calls.every((call) => call[1]?.behavior === "immediate"),
    ).toBe(true);
  });

  test("uses one set-based update, reports exact rows, and is idempotent", () => {
    const { database, store } = setup();
    addSession(database, "first");
    addSession(database, "second");
    addSession(database, "already-target", TARGET);
    addSession(database, "deleted", SOURCE, { deleted: true });
    addSession(database, "other-provider", "openrouter-target", {
      provider: "openrouter",
    });

    expectMigratedSessionCount(reassign(store), 2);
    expectMigratedSessionCount(reassign(store), 0);
    expect(
      database
        .select({ credentialId: agentSessions.providerCredentialId })
        .from(agentSessions)
        .where(undefined)
        .all()
        .filter(({ credentialId }) => credentialId === TARGET),
    ).toHaveLength(3);
  });

  test("clears Anthropic metadata when a generic credential is reassigned", () => {
    const { database, store } = setup();
    for (const [id, credentialId, options] of [
      [
        "generic-session",
        "generic-source",
        {
          adaptiveThinking: false,
          maxOutputTokens: 64_000,
          provider: "generic",
        },
      ],
      [
        "openai-session",
        SOURCE,
        { adaptiveThinking: true, maxOutputTokens: 32_000 },
      ],
    ] as const) {
      addSession(database, id, credentialId, options);
    }

    expectMigratedSessionCount(
      store.reassign({
        credentialId: "generic-target",
        now: NOW + 1,
        provider: "generic",
        userId: USER_ID,
      }),
      1,
    );
    expectMigratedSessionCount(reassign(store), 1);

    const metadata = new Map(
      database
        .select({
          adaptiveThinking: agentSessions.adaptiveThinking,
          id: agentSessions.id,
          maxOutputTokens: agentSessions.maxOutputTokens,
        })
        .from(agentSessions)
        .all()
        .map((row) => [row.id, row]),
    );
    // The generic endpoint may differ, so its metadata re-probes lazily; the
    // OpenAI credential change keeps the stored metadata.
    expect(metadata.get("generic-session")).toMatchObject({
      adaptiveThinking: null,
      maxOutputTokens: null,
    });
    expect(metadata.get("openai-session")).toMatchObject({
      adaptiveThinking: true,
      maxOutputTokens: 32_000,
    });
  });

  test("requires the target credential to be accessible in the selected scope", () => {
    const { database, store } = setup();
    const workspaceId = `workspace-${USER_ID}`;
    addSession(database, "session-1");
    database
      .update(providerCredentials)
      .set({ isGlobal: false })
      .where(eq(providerCredentials.id, TARGET))
      .run();

    const scopedReassignment = (selectedWorkspaceId: string) =>
      store.reassign({
        credentialId: TARGET,
        now: NOW + 1,
        provider: "openai",
        scope: { workspaceId: selectedWorkspaceId },
        userId: USER_ID,
      });

    expect(scopedReassignment(workspaceId)).toBeUndefined();
    expect(scopedReassignment(GLOBAL_WORKSPACE_ID)).toBeUndefined();

    database
      .insert(providerCredentialWorkspaces)
      .values({
        ...createdAuditFields(USER_ID, NOW),
        id: "target-workspace-scope",
        providerCredentialId: TARGET,
        userId: USER_ID,
        workspaceId,
      })
      .run();
    expect(scopedReassignment(workspaceId)).toEqual({
      migratedSessionCount: 1,
    });
  });

  test("does not expose a snapshot for an inaccessible target credential", () => {
    const { store } = setupWithSession();

    expect(
      store.snapshot({
        credentialId: "foreign-target",
        provider: "openai",
        userId: USER_ID,
      }),
    ).toBeUndefined();
  });

  test("applies prevalidated endpoint metadata atomically without clearing the tag", () => {
    const { database, store } = setup();
    addOpenRouterSession(database, {
      contextWindow: 128_000,
      pricing: JSON.stringify({ input: 1, output: 2 }),
    });
    const snapshot = openRouterSnapshot(store);

    expect(snapshot).toEqual({
      sessions: [
        {
          credentialId: "openrouter-target",
          id: "session-1",
          model: "vendor/model",
          openRouterProviderTag: "together",
        },
      ],
    });
    expectMigratedSessionCount(
      reassignOpenRouter(store, snapshot, [
        testSessionCredentialMetadataUpdate({
          providerPricing: {
            input: "0.0000002",
            output: "0.0000008",
          },
        }),
      ]),
      1,
    );
    expect(openRouterSessionMetadata(database)).toEqual(
      expectedOpenRouterSessionMetadata("openrouter-source"),
    );
  });

  test("rejects a stale prevalidation snapshot without changing any session", () => {
    const { database, store } = setup();
    addOpenRouterSession(database);
    const snapshot = openRouterSnapshot(store);
    database
      .update(agentSessions)
      .set({ model: "vendor/changed" })
      .where(eq(agentSessions.id, "session-1"))
      .run();

    expect(reassignOpenRouter(store, snapshot)).toBeUndefined();
    expect(sessionCredential(database)).toBe("openrouter-target");
  });
});
