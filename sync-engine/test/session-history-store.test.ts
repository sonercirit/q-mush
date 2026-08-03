import { expect, test } from "vitest";
import { agentMessages } from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  appendCompactionAssistantMessage,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

const USAGE = { contextTokens: null, costBasis: null, costUsd: null } as const;

test("compaction advances durable segment identity and pages old messages", () => {
  const setup = runningCompactionStore();
  appendCompactionAssistantMessage(setup, "Before compaction");

  setup.store.compactCurrentConversation(
    STORE_SESSION_ID,
    "Continue after handoff",
    USAGE,
    TEST_NOW + 3,
  );

  expect(setup.store.get(TEST_USER_ID, STORE_SESSION_ID)).toMatchObject({
    hasOlderSegments: true,
    messages: [
      {
        content: "Conversation compacted:\n\nContinue after handoff",
        role: "user",
      },
    ],
  });
  expect(
    setup.database
      .select({ segment: agentMessages.segment })
      .from(agentMessages)
      .orderBy(agentMessages.segment)
      .all()
      .map(({ segment }) => segment),
  ).toEqual([0, 0, 1]);

  const history = setup.store.history(TEST_USER_ID, STORE_SESSION_ID, null);
  expect(history).toMatchObject({
    currentSegment: 1,
    segment: 0,
    sessionId: STORE_SESSION_ID,
    tokenUsage: {
      cacheWriteInputTokens: 0,
      reportedStepCount: 0,
      stepCount: 1,
    },
  });
  expect(history?.messages.map(({ content }) => content)).toEqual([
    expect.any(String),
    "Before compaction",
  ]);
  expect(
    setup.store.history("other-user", STORE_SESSION_ID, null),
  ).toBeUndefined();

  setup.database.$client.close();
});
