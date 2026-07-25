import { createdAuditFields } from "../../shared/audit.ts";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import {
  providerCredentials,
  sessions,
  users,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import {
  createGoogleAuthFromEnvironment,
  type GoogleAuth,
} from "../../sync-engine/auth.ts";

export const TEST_NOW = 1_700_000_000_000;
export const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";
export const TEST_FOREIGN_USER_ID = "018bcfe5-6800-7000-8000-000000000023";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000022";
const SESSION_TOKEN = "authenticated-session";

export function testAuditFields(actorId = TEST_USER_ID) {
  return createdAuditFields(actorId, TEST_NOW);
}

export function createAuthenticatedTestDatabase(): AppDatabase {
  const database = createDatabase(":memory:");

  database
    .insert(users)
    .values({
      ...testAuditFields(SYSTEM_ID),
      email: "mushroom@example.com",
      googleSubject: "google-user",
      id: TEST_USER_ID,
      name: "Mush Room",
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

  return database;
}

export function createAuthenticatedTestContext(): {
  readonly auth: GoogleAuth;
  readonly database: AppDatabase;
} {
  const database = createAuthenticatedTestDatabase();
  const auth = createGoogleAuthFromEnvironment(
    {},
    { database, now: () => TEST_NOW },
  );
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
