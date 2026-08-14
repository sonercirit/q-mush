import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentMessages } from "../../shared/database/schema.ts";
import { readSessionSnapshot } from "../session-store-agent-read.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { privateReplay } from "./private-replay-fixtures.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

function sessionSnapshot(
  database: Parameters<typeof readSessionSnapshot>[0],
  roles: Parameters<typeof readSessionSnapshot>[1]["roles"],
) {
  return readSessionSnapshot(database, {
    includeSystem: false,
    limit: 10,
    roles,
    sessionId: STORE_SESSION_ID,
    userId: TEST_USER_ID,
  });
}

describe("stored session reads", () => {
  test("never selects private provider replay for read_session", () => {
    const { database, store } = runningStore();
    const replay = privateReplay(
      "read-session-private-signature",
      "Visible answer",
    );
    store.appendCurrentAgentMessage(
      STORE_SESSION_ID,
      {
        content: "Visible answer",
        providerReplay: replay,
        role: "assistant",
        toolCalls: [],
      },
      TEST_NOW + 2,
    );

    const snapshot = sessionSnapshot(database, ["assistant"]);

    expect(JSON.stringify(snapshot)).toContain("Visible answer");
    expect(JSON.stringify(snapshot)).not.toContain(
      "read-session-private-signature",
    );
    const replayQuery = database
      .select({ replay: agentMessages.providerReplay })
      .from(agentMessages);
    const replayRows = replayQuery
      .where(eq(agentMessages.role, "assistant"))
      .all();
    expect(replayRows[0]?.replay).toContain("read-session-private-signature");
    database.$client.close();
  });

  test("returns persisted error notices when the error category is selected", () => {
    const { database, store } = runningStore();
    // Truncation and failure notices persist as error rows; the database
    // filter must return them when selected, not only the formatter.
    store.appendRuntimeErrorMessage(
      STORE_SESSION_ID,
      "The response was truncated: it reached the maximum output tokens.",
      TEST_NOW + 2,
      0,
    );

    const snapshot = sessionSnapshot(database, ["assistant", "error"]);

    expect(
      snapshot?.transcript.messages.map(({ content, role }) => ({
        content,
        role,
      })),
    ).toContainEqual({
      content:
        "The response was truncated: it reached the maximum output tokens.",
      role: "error",
    });
    database.$client.close();
  });
});
