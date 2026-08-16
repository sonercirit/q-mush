import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { parseAnthropicAssistantReplay } from "../../shared/anthropic-replay.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { agentMessages } from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { replayIdentity } from "./session-replay-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

const REPLAY = {
  blocks: [
    {
      signature: "private-signature",
      thinking: "",
      type: "thinking" as const,
    },
    { text: "Answer", type: "text" as const },
  ],
  model: "fork-model",
  protocol: "anthropic" as const,
  provenance: "test-provenance",
};

function setStoredReplay(
  database: AppDatabase,
  role: "assistant" | "user",
  providerReplay: string,
): void {
  database
    .update(agentMessages)
    .set({ providerReplay })
    .where(eq(agentMessages.role, role))
    .run();
}

describe("stored provider replay", () => {
  test("public transcript reads never select private replay metadata", () => {
    const setup = runningStore();
    const select = vi.spyOn(setup.database, "select");

    setup.store.get(TEST_USER_ID, STORE_SESSION_ID);

    const selectedFields = select.mock.calls.flatMap(([selection]) =>
      Object.keys(selection),
    );
    setup.database.$client.close();
    expect(selectedFields).not.toContain("providerReplay");
  });

  test("rejects unrecognized fields in persisted blocks", () => {
    const serialized = JSON.stringify({
      blocks: [
        {
          signature: "signed",
          thinking: "",
          type: "thinking",
          unexpected: "field",
        },
      ],
      model: "claude-test",
      protocol: "anthropic",
      provenance: "test-provenance",
    });

    expect(() => parseAnthropicAssistantReplay(serialized)).toThrow(
      "Anthropic assistant replay data is invalid",
    );
    expect(() =>
      parseAnthropicAssistantReplay(
        JSON.stringify({ ...REPLAY, unexpected: "field" }),
      ),
    ).toThrow("Anthropic assistant replay data is invalid");
  });

  test("keeps replay private, ignores corrupt assistant metadata, and rejects misplaced replay", () => {
    const setup = runningStore();
    const { database, store } = setup;
    store.appendCurrentAgentMessage(
      STORE_SESSION_ID,
      {
        content: "Answer",
        providerReplay: REPLAY,
        role: "assistant",
        toolCalls: [],
      },
      TEST_NOW + 2,
    );

    expect(
      store.conversation(
        STORE_SESSION_ID,
        replayIdentity(REPLAY.model, REPLAY.provenance),
      )[1],
    ).toMatchObject({
      providerReplay: REPLAY,
    });
    expect(
      store.conversation(
        STORE_SESSION_ID,
        replayIdentity("different-model"),
        true,
      )[1],
    ).not.toHaveProperty("providerReplay");
    const detail = store.get(TEST_USER_ID, STORE_SESSION_ID);
    expect("providerReplay" in (detail?.messages[1] ?? {})).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("private-signature");

    setStoredReplay(database, "assistant", "not-json");
    const conversation = store.conversation.bind(
      store,
      STORE_SESSION_ID,
      replayIdentity(REPLAY.model, REPLAY.provenance),
    );
    expect(conversation()[1]).not.toHaveProperty("providerReplay");
    setStoredReplay(database, "user", JSON.stringify(REPLAY));
    const user = conversation().find(({ role }) => role === "user");
    expect({
      hasReplay: user !== undefined && "providerReplay" in user,
    }).toEqual({ hasReplay: false });
    database.$client.close();
  });
});
