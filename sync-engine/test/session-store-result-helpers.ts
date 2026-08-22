import { expect } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { CreateSessionResult } from "../../sync-engine/session-store-create.ts";

export function requireCreatedSession(
  created: CreateSessionResult,
  unavailable = "The test session runner is unavailable",
): AgentSessionDetail {
  expect(created.status).toBe("created");
  if (created.status !== "created") {
    throw new Error(unavailable);
  }
  return created.detail;
}
