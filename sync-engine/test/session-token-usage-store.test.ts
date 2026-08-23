import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { AgentTokenUsage } from "../../shared/agent-loop.ts";
import { agentMessages } from "../../shared/database/schema.ts";
import type { AgentSessionUsageUpdate } from "../../shared/session-model.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { storedSessionTokenUsage } from "../../sync-engine/session-token-usage-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { TEST_REPLAY_IDENTITY } from "./session-replay-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

const TOKEN_USAGE = {
  cacheWriteInputTokens: 50,
  cachedInputTokens: 600,
  inputTokens: 1_000,
  outputTokens: 200,
} as const;

const NEXT_SEGMENT_TOKEN_USAGE = {
  cacheWriteInputTokens: 25,
  cachedInputTokens: 200,
  inputTokens: 400,
  outputTokens: 100,
} as const;

const SINGLE_STEP_SUMMARY = {
  ...TOKEN_USAGE,
  lastInputTokens: TOKEN_USAGE.inputTokens,
  reportedStepCount: 1,
} as const;

function appendStep(
  store: SessionStore,
  content: string,
  now: number,
  tokenUsage?: AgentTokenUsage,
): void {
  const message = { content, role: "assistant" as const, toolCalls: [] };
  if (tokenUsage === undefined) {
    store.appendCurrentAgentMessage(STORE_SESSION_ID, message, now);
    return;
  }
  const usage: AgentSessionUsageUpdate = {
    contextTokens: tokenUsage.inputTokens,
    costBasis: null,
    costUsd: null,
    tokenUsage,
  };
  store.appendRuntimeAgentMessages(STORE_SESSION_ID, [message], now, 0, usage);
}

test("persists model-step usage on its assistant message and aggregates it", () => {
  const setup = runningStore();
  setup.store.appendRuntimeAgentMessages(
    STORE_SESSION_ID,
    [
      { content: "Reasoning", role: "thinking" },
      { content: "Answer", role: "assistant", toolCalls: [] },
    ],
    TEST_NOW + 2,
    0,
    {
      contextTokens: 1_000,
      costBasis: null,
      costUsd: null,
      tokenUsage: TOKEN_USAGE,
    },
  );

  const detail = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
  expect(detail?.messages.at(-1)?.tokenUsage).toEqual(TOKEN_USAGE);
  expect(detail?.tokenUsage).toEqual({ ...SINGLE_STEP_SUMMARY, stepCount: 1 });
  expect(detail?.segmentTokenUsage).toEqual(detail?.tokenUsage);
  expect(setup.store.list(TEST_USER_ID)[0]).not.toHaveProperty("tokenUsage");
  expect(
    setup.database
      .select({
        cached: agentMessages.cachedInputTokens,
        input: agentMessages.inputTokens,
        output: agentMessages.outputTokens,
        written: agentMessages.cacheWriteInputTokens,
      })
      .from(agentMessages)
      .where(eq(agentMessages.role, "assistant"))
      .all()
      .at(-1),
  ).toEqual({ cached: 600, input: 1_000, output: 200, written: 50 });
  setup.database.$client.close();
});

test("a partially reported step never becomes the cache-rate divisor", () => {
  const setup = runningStore();
  appendStep(setup.store, "Reported step", TEST_NOW + 2, TOKEN_USAGE);
  appendStep(setup.store, "Partial step", TEST_NOW + 3);
  setup.database
    .update(agentMessages)
    .set({ inputTokens: 9_999 })
    .where(eq(agentMessages.content, "Partial step"))
    .run();

  // The sums skip the partial row, so the last-input subtraction must too:
  // otherwise rates divide by summed input minus tokens never counted.
  expect(storedSessionTokenUsage(setup.database, STORE_SESSION_ID)).toEqual({
    ...SINGLE_STEP_SUMMARY,
    stepCount: 2,
  });
  setup.database.$client.close();
});

test("aggregates partial usage coverage by each message's segment", () => {
  const setup = runningStore();
  appendStep(setup.store, "First reported step", TEST_NOW + 2, TOKEN_USAGE);
  appendStep(setup.store, "First unreported step", TEST_NOW + 3);
  setup.store.compactCurrentConversation(
    STORE_SESSION_ID,
    "Continue in the next segment",
    { contextTokens: null, costBasis: null, costUsd: null },
    TEST_NOW + 4,
  );
  appendStep(
    setup.store,
    "Second reported step",
    TEST_NOW + 5,
    NEXT_SEGMENT_TOKEN_USAGE,
  );
  appendStep(setup.store, "Second unreported step", TEST_NOW + 6);
  expect(
    setup.store.conversation(STORE_SESSION_ID, TEST_REPLAY_IDENTITY),
  ).toHaveLength(3);

  const session = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
  expect(session?.tokenUsage).toEqual({
    cacheWriteInputTokens: 75,
    cachedInputTokens: 800,
    inputTokens: 1_400,
    lastInputTokens: NEXT_SEGMENT_TOKEN_USAGE.inputTokens,
    outputTokens: 300,
    reportedStepCount: 2,
    stepCount: 5,
  });
  expect(session?.segmentTokenUsage).toEqual({
    ...NEXT_SEGMENT_TOKEN_USAGE,
    lastInputTokens: NEXT_SEGMENT_TOKEN_USAGE.inputTokens,
    reportedStepCount: 1,
    stepCount: 2,
  });
  expect(
    setup.store.history(TEST_USER_ID, STORE_SESSION_ID, null)?.tokenUsage,
  ).toEqual({ ...SINGLE_STEP_SUMMARY, stepCount: 3 });
  setup.database.$client.close();
});
