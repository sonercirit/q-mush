import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runners } from "../database/schema.ts";
import { SessionStore } from "../session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000042";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";
const USER_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000044";
const THINKING_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000045";
const ASSISTANT_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000046";
const TOOL_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000047";

function createStore() {
  const database = createAuthenticatedTestDatabase();
  const timestamp = new Date(TEST_NOW);
  database
    .insert(runners)
    .values({
      ...testAuditFields(),
      architecture: "x64",
      id: RUNNER_ID,
      lastSeenAt: timestamp,
      machineFingerprint: "session-store-machine",
      name: "workstation",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update("runner-token")
        .digest("base64url"),
      userId: TEST_USER_ID,
    })
    .run();
  addTestProviderCredential(database, CREDENTIAL_ID);
  const ids = [
    SESSION_ID,
    USER_MESSAGE_ID,
    THINKING_MESSAGE_ID,
    ASSISTANT_MESSAGE_ID,
    TOOL_MESSAGE_ID,
  ];
  return {
    database,
    store: new SessionStore(database, () =>
      takeValue(ids, "The test ran out of session IDs"),
    ),
  };
}

describe("session store", () => {
  test("persists a session transcript and lifecycle", () => {
    const { database, store } = createStore();
    const created = store.create(
      {
        credentialId: CREDENTIAL_ID,
        model: "gpt-4.1-mini",
        prompt: "Inspect the repository\nand make it shine",
        provider: "openai",
        reasoningEffort: "high",
        runnerId: RUNNER_ID,
        userId: TEST_USER_ID,
        workingDirectory: "/work/project",
      },
      TEST_NOW,
    );

    expect(created.id).toBe(SESSION_ID);
    expect(created.status).toBe("queued");
    expect(created.reasoningEffort).toBe("high");
    expect(created.title).toBe("Inspect the repository");
    expect(created.messages).toEqual([
      {
        content: "Inspect the repository\nand make it shine",
        createdAt: TEST_NOW,
        id: USER_MESSAGE_ID,
        role: "user",
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      },
    ]);
    expect(store.mark(SESSION_ID, "running", TEST_NOW + 1)).toBeTrue();

    const thinkingMessage = {
      content: "I should inspect the repository before changing it.",
      role: "thinking" as const,
    };
    const assistantMessage = {
      content: "I will inspect it.",
      role: "assistant" as const,
      toolCalls: [
        {
          arguments: '{"command":"ls"}',
          id: "call-1",
          name: "bash",
        },
      ],
    };
    const toolMessage = {
      content: "README.md",
      role: "tool" as const,
      toolCallId: "call-1",
      toolName: "bash",
    };
    store.appendAgentMessage(SESSION_ID, thinkingMessage, TEST_NOW + 2);
    store.appendAgentMessage(SESSION_ID, assistantMessage, TEST_NOW + 3);
    store.appendAgentMessage(SESSION_ID, toolMessage, TEST_NOW + 4);
    expect(store.mark(SESSION_ID, "idle", TEST_NOW + 5)).toBeTrue();

    const detail = store.get(TEST_USER_ID, SESSION_ID);
    expect(detail?.status).toBe("idle");
    expect(detail?.messages.slice(1)).toEqual([
      {
        ...thinkingMessage,
        createdAt: TEST_NOW + 2,
        id: THINKING_MESSAGE_ID,
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      },
      {
        ...assistantMessage,
        createdAt: TEST_NOW + 3,
        id: ASSISTANT_MESSAGE_ID,
        toolCallId: null,
        toolName: null,
      },
      {
        ...toolMessage,
        createdAt: TEST_NOW + 4,
        id: TOOL_MESSAGE_ID,
        toolCalls: [],
      },
    ]);
    expect(store.list(TEST_USER_ID)).toHaveLength(1);
    database.$client.close();
  });
});
