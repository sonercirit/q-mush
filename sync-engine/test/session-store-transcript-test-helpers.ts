import { expect } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionStore } from "../session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

export function testSessionMessageRoles(store: SessionStore) {
  return store
    .get(TEST_USER_ID, STORE_SESSION_ID)
    ?.messages.map(({ role }) => role);
}

export function expectPersistedTurns(
  actual: AgentSessionDetail["turns"],
  firstBoundaryMessageId: string | undefined,
  last: Readonly<{
    readonly endedAt: number | null;
    readonly startedAt: number;
  }>,
): void {
  expect(actual).toEqual([
    expect.objectContaining({
      boundaryMessageId: firstBoundaryMessageId,
      endedAt: TEST_NOW + 3,
      startedAt: TEST_NOW,
    }),
    expect.objectContaining(last),
  ]);
}

export function expectedTranscriptRoles(
  includeError: boolean,
  includeFollowUp = false,
): readonly string[] {
  return [
    "user",
    "assistant",
    ...(includeError ? ["error"] : []),
    "tool",
    ...(includeFollowUp ? ["user"] : []),
  ];
}

export function initialConversation() {
  return [
    {
      content: "Inspect the repository\nand make it shine",
      images: [TEST_AGENT_IMAGE],
      role: "user" as const,
    },
  ];
}
