import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agentMessages } from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

const TOKEN_USAGE = {
  cacheWriteInputTokens: 50,
  cachedInputTokens: 600,
  inputTokens: 1_000,
  outputTokens: 200,
} as const;

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
  expect(detail?.tokenUsage).toEqual({
    ...TOKEN_USAGE,
    reportedStepCount: 1,
    stepCount: 1,
  });
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
