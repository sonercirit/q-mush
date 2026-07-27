import { expect } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../../shared/session-model.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";

export interface SessionStoreTestSetup {
  readonly database: AppDatabase;
  readonly store: SessionStore;
}

export function closeSessionTestDatabase(database: AppDatabase): void {
  database.$client.close();
}

export async function expectJsonResponse(
  response: Response,
  status: number,
  expected: unknown,
): Promise<void> {
  const body: unknown = await response.json();
  expect(response.status).toBe(status);
  expect(body).toEqual(expected);
}

export function expectStoredSession(
  setup: Pick<SessionStoreTestSetup, "store">,
  userId: string,
  sessionId: string,
  expected: object,
): AgentSessionDetail {
  const detail = setup.store.get(userId, sessionId);
  expect(detail).toMatchObject(expected);
  if (detail === undefined) {
    throw new Error(`The test session ${sessionId} is missing`);
  }
  return detail;
}

export function expectedRestartHandoff(
  executionGeneration: number,
  operation: RestartHandoffOperation,
  restartId: string,
) {
  return {
    executionGeneration,
    operation,
    pendingInput: [],
    requestedBy: "runner" as const,
    restartId,
  };
}
