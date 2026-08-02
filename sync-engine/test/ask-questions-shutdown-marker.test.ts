import { expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { testAskQuestionsInput } from "./ask-questions-test-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { closeSessionStoreTestSetup } from "./session-store-reassignment-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

test("stopping a question-paused session clears its shutdown marker", () => {
  const { database, store } = runningStore();
  const generation = store.get(TEST_USER_ID, STORE_SESSION_ID)?.generation;
  if (generation === undefined) {
    throw new Error("The running session is unavailable");
  }
  store
    .questions()
    .create(
      TEST_USER_ID,
      STORE_SESSION_ID,
      generation,
      "call-question",
      testAskQuestionsInput(),
      TEST_NOW + 2,
    );
  database
    .update(agentSessions)
    .set({ interruptedHandoff: "durable-shutdown-marker" })
    .run();

  expect(store.stop(TEST_USER_ID, STORE_SESSION_ID, TEST_NOW + 3)).toBe(true);
  expect(
    database
      .select({ marker: agentSessions.interruptedHandoff })
      .from(agentSessions)
      .get()?.marker,
  ).toBeNull();
  closeSessionStoreTestSetup({ database, store });
});
