import * as databaseModule from "../database.ts";
import * as schema from "../database/schema.ts";
import { SYSTEM_ID } from "../ids.ts";

export const TEST_NOW = 1_700_000_000_000;
export const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000022";
const SESSION_TOKEN = "authenticated-session";

export function createAuthenticatedTestDatabase(): databaseModule.AppDatabase {
  const database = databaseModule.createDatabase(":memory:");
  const timestamp = new Date(TEST_NOW);

  database
    .insert(schema.users)
    .values({
      createdAt: timestamp,
      createdById: SYSTEM_ID,
      email: "mushroom@example.com",
      googleSubject: "google-user",
      id: TEST_USER_ID,
      isDeleted: false,
      name: "Mush Room",
      updatedAt: timestamp,
      updatedById: SYSTEM_ID,
    })
    .run();
  database
    .insert(schema.sessions)
    .values({
      createdAt: timestamp,
      createdById: TEST_USER_ID,
      expiresAt: new Date(TEST_NOW + 60_000),
      id: SESSION_ID,
      isDeleted: false,
      token: SESSION_TOKEN,
      updatedAt: timestamp,
      updatedById: TEST_USER_ID,
      userId: TEST_USER_ID,
    })
    .run();

  return database;
}

export function createAuthenticatedRequest(
  path: string,
  body?: Readonly<Record<string, string>>,
  method = "GET",
): Request {
  const headers = new Headers({ cookie: `q_mush_session=${SESSION_TOKEN}` });

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const init: RequestInit =
    body === undefined
      ? { headers, method }
      : { body: JSON.stringify(body), headers, method };

  return new Request(`http://localhost:3000${path}`, init);
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
