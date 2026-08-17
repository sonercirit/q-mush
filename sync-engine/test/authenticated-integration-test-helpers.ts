import { expect } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import {
  providerCredentials,
  sessions,
  users,
  workspaces,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { DEFAULT_WORKSPACE_NAME } from "../../shared/workspace-model.ts";
import {
  createGoogleAuthFromEnvironment,
  type GoogleAuth,
} from "../../sync-engine/auth.ts";

export const TEST_NOW = 1_700_000_000_000;
export const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";
export const TEST_FOREIGN_USER_ID = "018bcfe5-6800-7000-8000-000000000023";
export const TEST_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000024";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000022";
const SESSION_TOKEN = "authenticated-session";

export const TEST_AUTHENTICATED_USER: AuthenticatedUser = {
  email: "mushroom@example.com",
  id: TEST_USER_ID,
  name: "Mush Room",
};

export function expectResponseStatuses(
  responses: readonly Response[],
  status: number,
): void {
  expect(responses.map((response) => response.status)).toEqual(
    responses.map(() => status),
  );
}

export function testAuditFields(actorId = TEST_USER_ID) {
  return createdAuditFields(actorId, TEST_NOW);
}

function addGlobalColumn(
  database: AppDatabase,
  table: "provider_credentials" | "runners",
): void {
  const columns = database.$client
    .query<{ readonly name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  if (!columns.some(({ name }) => name === "is_global")) {
    database.$client.run(
      `ALTER TABLE ${table} ADD COLUMN is_global integer NOT NULL DEFAULT true`,
    );
  }
}

export function ensureWaveOneColumns(database: AppDatabase): void {
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS prompts (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      name text NOT NULL,
      normalized_name text NOT NULL,
      body text NOT NULL,
      revision integer DEFAULT 1 NOT NULL,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer DEFAULT false NOT NULL,
      CONSTRAINT prompts_revision_positive_check CHECK (revision > 0)
    )
  `);
  database.$client.run(
    "CREATE INDEX IF NOT EXISTS prompts_user_deletion_update_index ON prompts (user_id, is_deleted, updated_at)",
  );
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS prompts_user_normalized_name_active_unique ON prompts (user_id, normalized_name) WHERE NOT is_deleted",
  );
  const workspaceColumns = database.$client
    .query<{ readonly name: string }, []>("PRAGMA table_info(workspaces)")
    .all();
  if (workspaceColumns.length === 0) {
    database.$client.run(`
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
    database.$client.run(
      "CREATE UNIQUE INDEX workspaces_user_default_unique ON workspaces(user_id) WHERE NOT is_deleted AND is_default",
    );
  }
  addGlobalColumn(database, "provider_credentials");
  const sessionColumns = database.$client
    .query<{ readonly name: string }, []>("PRAGMA table_info(agent_sessions)")
    .all();
  if (!sessionColumns.some(({ name }) => name === "agent_file_path")) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN agent_file_path text",
    );
  }
  if (
    !sessionColumns.some(({ name }) => name === "parent_reported_generation")
  ) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN parent_reported_generation integer NOT NULL DEFAULT -1",
    );
  }
  database.$client.run(
    "CREATE INDEX IF NOT EXISTS agent_sessions_parent_report_index ON agent_sessions(status, parent_session_id, parent_execution_generation, parent_reported_generation)",
  );
  if (!sessionColumns.some(({ name }) => name === "workspace_id")) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN workspace_id text REFERENCES workspaces(id) ON DELETE restrict",
    );
  }
  if (!sessionColumns.some(({ name }) => name === "openrouter_provider_tag")) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN openrouter_provider_tag text",
    );
  }
  if (!sessionColumns.some(({ name }) => name === "execution_environment")) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN execution_environment text NOT NULL DEFAULT 'bare_metal'",
    );
  }
  if (!sessionColumns.some(({ name }) => name === "restart_handoff")) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN restart_handoff text",
    );
  }
  if (
    !sessionColumns.some(({ name }) => name === "shutdown_interrupted_handoff")
  ) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN shutdown_interrupted_handoff text",
    );
  }
  if (!sessionColumns.some(({ name }) => name === "current_segment")) {
    database.$client.run(
      "ALTER TABLE agent_sessions ADD COLUMN current_segment integer NOT NULL DEFAULT 0",
    );
  }
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS agent_session_turns (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE restrict,
      segment integer NOT NULL DEFAULT 0,
      execution_generation integer NOT NULL,
      boundary_message_id text,
      started_at integer NOT NULL,
      ended_at integer,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer NOT NULL DEFAULT false
    )
  `);
  const messageColumns = database.$client
    .query<{ readonly name: string }, []>("PRAGMA table_info(agent_messages)")
    .all();
  if (!messageColumns.some(({ name }) => name === "segment")) {
    database.$client.run(
      "ALTER TABLE agent_messages ADD COLUMN segment integer NOT NULL DEFAULT 0",
    );
  }
  if (!messageColumns.some(({ name }) => name === "turn_id")) {
    database.$client.run("ALTER TABLE agent_messages ADD COLUMN turn_id text");
  }
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS agent_question_requests (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE restrict,
      tool_call_id text NOT NULL,
      execution_generation integer NOT NULL,
      questions text NOT NULL,
      answers text,
      answered_at integer,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer NOT NULL DEFAULT false
    )
  `);
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS agent_pending_inputs (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE restrict,
      client_request_id text NOT NULL,
      kind text NOT NULL,
      content text NOT NULL,
      images text,
      sequence integer NOT NULL,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer NOT NULL DEFAULT false
    )
  `);
  database.$client.run(
    "CREATE INDEX IF NOT EXISTS agent_pending_inputs_session_deletion_sequence_index ON agent_pending_inputs(session_id, is_deleted, sequence)",
  );
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS agent_pending_inputs_session_sequence_unique ON agent_pending_inputs(session_id, sequence)",
  );
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS agent_pending_inputs_user_request_unique ON agent_pending_inputs(user_id, client_request_id)",
  );
  const runnerColumns = database.$client
    .query<{ readonly name: string }, []>("PRAGMA table_info(runners)")
    .all();
  addGlobalColumn(database, "runners");
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS provider_quota_settings (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      provider_credential_id text NOT NULL REFERENCES provider_credentials(id) ON DELETE restrict,
      auto_reset_threshold_percent real NOT NULL DEFAULT 1,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer NOT NULL DEFAULT false
    )
  `);
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS provider_quota_settings_active_credential_unique ON provider_quota_settings(provider_credential_id) WHERE NOT is_deleted",
  );
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS provider_quota_reset_receipts (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      provider_credential_id text NOT NULL REFERENCES provider_credentials(id) ON DELETE restrict,
      client_request_id text NOT NULL,
      outcome text,
      completed_at integer,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer NOT NULL DEFAULT false
    )
  `);
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS provider_quota_reset_receipts_active_request_unique ON provider_quota_reset_receipts(user_id, provider_credential_id, client_request_id) WHERE NOT is_deleted",
  );
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS provider_quota_reset_receipts_pending_credential_unique ON provider_quota_reset_receipts(provider_credential_id) WHERE NOT is_deleted AND outcome IS NULL",
  );
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS provider_credential_workspaces (
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
  database.$client.run(`
    CREATE TABLE IF NOT EXISTS runner_workspaces (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
      runner_id text NOT NULL REFERENCES runners(id) ON DELETE restrict,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE restrict,
      created_at integer NOT NULL,
      created_by_id text NOT NULL,
      updated_at integer NOT NULL,
      updated_by_id text NOT NULL,
      is_deleted integer NOT NULL DEFAULT false
    )
  `);
  const additions = [
    ["token_digest", "text NOT NULL DEFAULT ''"],
    ["activation_generation", "integer NOT NULL DEFAULT 0"],
    ["activation_id", "text"],
    ["activation_phase", "text"],
    ["activation_restart_id", "text"],
    ["activation_lifecycle", "text"],
    ["activation_lifecycle_settled", "integer NOT NULL DEFAULT false"],
    ["activation_source_id", "text"],
    ["activation_target_id", "text"],
    ["activation_target_generation", "integer"],
    ["activation_reservation_id", "text"],
    ["activation_reservation_generation", "integer"],
    ["activation_reservation_source_id", "text"],
    ["activation_machine_fingerprint", "text"],
    ["activation_platform", "text"],
    ["activation_architecture", "text"],
    ["activation_name", "text"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!runnerColumns.some((column) => column.name === name)) {
      database.$client.run(
        `ALTER TABLE runners ADD COLUMN ${name} ${definition}`,
      );
    }
  }
  const legacyTokens = database.$client
    .query<{ readonly id: string; readonly tokenHash: string }, []>(
      "SELECT id, token_hash AS tokenHash FROM runners WHERE is_deleted = false AND token_digest = '' ORDER BY id",
    )
    .all();
  const seenDigests = new Set(
    database.$client
      .query<{ readonly digest: string }, []>(
        "SELECT token_digest AS digest FROM runners WHERE is_deleted = false AND token_digest <> ''",
      )
      .all()
      .map(({ digest }) => digest),
  );
  for (const { id, tokenHash } of legacyTokens) {
    if (seenDigests.has(tokenHash)) {
      database.$client.run(
        "UPDATE runners SET is_deleted = true WHERE id = ? AND token_digest = ''",
        [id],
      );
      continue;
    }
    seenDigests.add(tokenHash);
    database.$client.run(
      "UPDATE runners SET token_digest = ? WHERE id = ? AND token_digest = ''",
      [tokenHash, id],
    );
  }
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS runners_active_token_digest_unique ON runners (token_digest) WHERE is_deleted = false AND token_digest <> ''",
  );
  database.$client.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS runners_active_activation_id_unique ON runners (activation_id) WHERE is_deleted = false AND activation_id IS NOT NULL",
  );
}

export function createSchemaCompatibleTestDatabase(): AppDatabase {
  const database = createDatabase(":memory:");
  ensureWaveOneColumns(database);
  return database;
}

export function createAuthenticatedTestDatabase(): AppDatabase {
  const database = createSchemaCompatibleTestDatabase();

  database
    .insert(users)
    .values({
      ...testAuditFields(SYSTEM_ID),
      email: TEST_AUTHENTICATED_USER.email,
      googleSubject: "google-user",
      id: TEST_AUTHENTICATED_USER.id,
      name: TEST_AUTHENTICATED_USER.name,
    })
    .run();
  database
    .insert(sessions)
    .values({
      ...testAuditFields(),
      expiresAt: new Date(TEST_NOW + 60_000),
      id: SESSION_ID,
      token: SESSION_TOKEN,
      userId: TEST_USER_ID,
    })
    .run();
  database
    .insert(workspaces)
    .values({
      ...testAuditFields(),
      id: TEST_WORKSPACE_ID,
      isDefault: true,
      name: DEFAULT_WORKSPACE_NAME,
      userId: TEST_USER_ID,
    })
    .run();

  return database;
}

export function createTestAuth(
  database: AppDatabase,
  now = TEST_NOW,
): GoogleAuth {
  return createGoogleAuthFromEnvironment({}, { database, now: () => now });
}

export function createAuthenticatedTestContext(): {
  readonly auth: GoogleAuth;
  readonly database: AppDatabase;
} {
  const database = createAuthenticatedTestDatabase();
  const auth = createTestAuth(database);
  return { auth, database };
}

export function addTestUser(
  database: AppDatabase,
  id = TEST_FOREIGN_USER_ID,
): void {
  database
    .insert(users)
    .values({
      ...testAuditFields(SYSTEM_ID),
      email: `${id}@example.test`,
      googleSubject: `google-${id}`,
      id,
      name: "Test User",
    })
    .run();
}

export function createTestProviderCredential(
  id: string,
  source: ProviderCredentialAccess["source"] = "api_key",
  overrides: Partial<ProviderCredentialAccess> = {},
): ProviderCredentialAccess {
  const identity = {
    accountId: "provider-account",
    id,
    isDefault: false,
  };
  return {
    ...identity,
    label: "Agent key",
    secret: "provider-secret",
    source,
    ...overrides,
  };
}

export function addTestProviderCredential(
  database: AppDatabase,
  id: string,
  provider: "openai" | "openrouter" = "openai",
  options: {
    readonly accountId?: string | null;
    readonly isDefault?: boolean;
    readonly isDeleted?: boolean;
    readonly label?: string;
    readonly source?: "api_key" | "oauth";
    readonly userId?: string;
  } = {},
): void {
  const userId = options.userId ?? TEST_USER_ID;
  database
    .insert(providerCredentials)
    .values({
      ...testAuditFields(userId),
      ...(options.isDeleted === undefined
        ? {}
        : { isDeleted: options.isDeleted }),
      credentialFingerprint: `fingerprint-${id}`,
      encryptedCredential: "test-encrypted-credential",
      id,
      isDefault: options.isDefault ?? false,
      label: options.label ?? "Test credential",
      provider,
      providerAccountId: options.accountId ?? null,
      source: options.source ?? "api_key",
      userId,
    })
    .run();
}

function createTestRequest(
  path: string,
  headers: Headers,
  body: Readonly<Record<string, unknown>> | undefined,
  method: string,
): Request {
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new Request(`http://localhost:3000${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers,
    method,
  });
}

export function createRunnerRequest(
  path: string,
  token: string,
  body?: Readonly<Record<string, unknown>>,
  method = "POST",
): Request {
  return createTestRequest(
    path,
    new Headers({ authorization: `Bearer ${token}` }),
    body,
    method,
  );
}

export function createAuthenticatedRequest(
  path: string,
  body?: Readonly<Record<string, unknown>>,
  method = "GET",
): Request {
  return createTestRequest(
    path,
    new Headers({ cookie: `q_mush_session=${SESSION_TOKEN}` }),
    body,
    method,
  );
}

function flowCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

export function addFlowCookies(request: Request, response: Response): void {
  const sessionCookie = request.headers.get("cookie");

  if (sessionCookie === null) {
    throw new Error("The authenticated request has no session cookie");
  }

  request.headers.set("cookie", `${sessionCookie}; ${flowCookies(response)}`);
}

export function readFlowCookies(response: Response): string {
  return flowCookies(response);
}
