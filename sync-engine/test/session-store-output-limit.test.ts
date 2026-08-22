import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

function appendRuntimeAnswer(
  store: ReturnType<typeof runningStore>["store"],
  messages: Parameters<typeof store.appendRuntimeAgentMessages>[1],
): void {
  store.appendRuntimeAgentMessages(STORE_SESSION_ID, messages, TEST_NOW + 2, 0);
}

function expectRecovered(
  store: ReturnType<typeof runningStore>["store"],
): void {
  expect(store.failInterrupted(TEST_NOW + 3)).toEqual([]);
}

describe("session store output limits", () => {
  test("rejects an invalid persisted output-token limit", () => {
    const { database, store } = createStore();

    for (const maxOutputTokens of [0, -5, 1.5, Number.MAX_VALUE]) {
      expect(() =>
        createTestSession(store, TEST_NOW, { maxOutputTokens }),
      ).toThrow("output limit is invalid");
    }
    database.$client.close();
  });

  test("recovers a terminal child as idle when only its callback route was cleared", () => {
    const { database, store } = runningStore();
    database
      .update(agentSessions)
      .set({ parentCallbackGeneration: null, parentExecutionGeneration: 7 })
      .where(eq(agentSessions.id, STORE_SESSION_ID))
      .run();
    appendRuntimeAnswer(store, [
      { content: "Recovered child answer", role: "assistant", toolCalls: [] },
    ]);

    expectRecovered(store);
    expect(store.get(TEST_USER_ID, STORE_SESSION_ID)).toMatchObject({
      parentExecutionGeneration: 7,
      status: "idle",
    });
    database.$client.close();
  });

  test("recovers a truncated terminal answer instead of failing it", () => {
    const { database, store } = runningStore();
    // The step settled durably — assistant answer plus its truncation
    // notice — but the process exited before the session row settled.
    const notice =
      "The response was truncated: it reached the maximum output tokens.";
    appendRuntimeAnswer(store, [
      { content: "Truncated answer", role: "assistant", toolCalls: [] },
      { content: notice, role: "error" },
    ]);

    expectRecovered(store);

    const recovered = store.get(TEST_USER_ID, STORE_SESSION_ID);
    const trailingRoles = recovered?.messages.map(({ role }) => role).slice(-2);
    expect(recovered?.status).toBe("idle");
    expect(trailingRoles).toEqual(["assistant", "error"]);
    database.$client.close();
  });
});
