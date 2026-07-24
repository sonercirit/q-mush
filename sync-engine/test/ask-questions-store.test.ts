/* jscpd:ignore-start */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  readAskQuestionsInput,
  type AskQuestionAnswers,
} from "../../shared/ask-questions.ts";
import {
  agentMessages,
  agentQuestionRequests,
  runners,
} from "../../shared/database/schema.ts";
import { AskQuestionsStore } from "../../sync-engine/ask-questions-store.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000201";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000202";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000203";
const MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000204";
const REQUEST_ID = "018bcfe5-6800-7000-8000-000000000205";
const FOLLOWUP_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000206";

function setup() {
  const database = createAuthenticatedTestDatabase();
  const timestamp = new Date(TEST_NOW);
  database
    .insert(runners)
    .values({
      architecture: "x64",
      createdAt: timestamp,
      createdById: TEST_USER_ID,
      id: RUNNER_ID,
      isDeleted: false,
      lastSeenAt: timestamp,
      machineFingerprint: "ask-question-machine",
      name: "workstation",
      platform: "linux",
      tokenHash: createHash("sha256").update("token").digest("base64url"),
      updatedAt: timestamp,
      updatedById: TEST_USER_ID,
      userId: TEST_USER_ID,
    })
    .run();
  addTestProviderCredential(database, CREDENTIAL_ID);
  const ids = [SESSION_ID, MESSAGE_ID, FOLLOWUP_MESSAGE_ID];
  const sessions = new SessionStore(database, () => {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error("The ask-questions store test ran out of IDs");
    }
    return id;
  });
  sessions.create(
    {
      autoCompact: true,
      credentialId: CREDENTIAL_ID,
      images: [],
      maxContextTokens: null,
      model: "gpt-test",
      prompt: "Ask me before proceeding",
      provider: "openai",
      providerPricing: null,
      reasoningEffort: null,
      runnerId: RUNNER_ID,
      tools: ["ask_questions"],
      userId: TEST_USER_ID,
      workingDirectory: "/work",
    },
    TEST_NOW,
  );
  sessions.mark(SESSION_ID, "running", TEST_NOW + 1);
  const store = new AskQuestionsStore({
    database,
    generateId: () => REQUEST_ID,
  });
  return { database, sessions, store };
}

const parsedInput = readAskQuestionsInput({
  questions: [
    {
      id: "decision",
      options: [
        { label: "Proceed", value: "proceed" },
        { label: "Stop", value: "stop" },
      ],
      prompt: "What next?",
      type: "single_choice",
    },
  ],
});
if (parsedInput === undefined) {
  throw new Error("The test ask_questions input is invalid");
}
const input = parsedInput;
const answers: AskQuestionAnswers = {
  answers: [{ questionId: "decision", value: "proceed" }],
};

describe("ask questions store", () => {
  test("persists one audited pending call and returns it idempotently", () => {
    const { database, sessions, store } = setup();

    const created = store.create(
      TEST_USER_ID,
      SESSION_ID,
      "call-question",
      input,
      TEST_NOW + 2,
    );
    const repeated = store.create(
      TEST_USER_ID,
      SESSION_ID,
      "call-question",
      input,
      TEST_NOW + 3,
    );

    expect(repeated).toEqual(created);
    expect(store.pending(TEST_USER_ID, SESSION_ID)).toEqual(created);
    expect(store.pending(TEST_USER_ID, "another-session")).toBeNull();
    expect(store.input(TEST_USER_ID, "another-session", REQUEST_ID)).toBe(
      undefined,
    );
    expect(store.input(TEST_USER_ID, SESSION_ID, REQUEST_ID)).toEqual(input);
    expect(
      store.answer(
        TEST_USER_ID,
        "another-session",
        REQUEST_ID,
        answers,
        TEST_NOW + 3,
      ),
    ).toBe("not_found");
    expect(sessions.get(TEST_USER_ID, SESSION_ID)?.status).toBe("waiting");
    expect(database.$client.query("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
    expect(database.select().from(agentQuestionRequests).get()).toMatchObject({
      answeredAt: null,
      createdById: TEST_USER_ID,
      id: REQUEST_ID,
      isDeleted: false,
      sessionId: SESSION_ID,
      toolCallId: "call-question",
      userId: TEST_USER_ID,
    });
    database.$client.close();
  });

  test("does not create a pending request if pausing the session fails", () => {
    const { database, sessions, store } = setup();
    expect(sessions.mark(SESSION_ID, "idle", TEST_NOW + 2)).toBe(true);

    expect(() =>
      store.create(
        TEST_USER_ID,
        SESSION_ID,
        "call-question",
        input,
        TEST_NOW + 3,
      ),
    ).toThrow("not running");
    expect(database.select().from(agentQuestionRequests).all()).toEqual([]);
    expect(sessions.get(TEST_USER_ID, SESSION_ID)?.status).toBe("idle");
    database.$client.close();
  });

  test("answers atomically, idempotently, and only for the owner", () => {
    const { database, sessions, store } = setup();
    store.create(
      TEST_USER_ID,
      SESSION_ID,
      "call-question",
      input,
      TEST_NOW + 2,
    );

    expect(
      store.answer(
        "another-user",
        SESSION_ID,
        REQUEST_ID,
        answers,
        TEST_NOW + 3,
      ),
    ).toBe("not_found");
    const canonicalResult =
      '{\n  "answers": [\n    {\n      "questionId": "decision",\n      "value": "proceed"\n    }\n  ]\n}';
    expect(
      store.answer(TEST_USER_ID, SESSION_ID, REQUEST_ID, answers, TEST_NOW + 4),
    ).toEqual({ result: canonicalResult, status: "answered" });
    expect(store.input(TEST_USER_ID, SESSION_ID, REQUEST_ID)).toEqual(input);
    expect(
      store.answer(TEST_USER_ID, SESSION_ID, REQUEST_ID, answers, TEST_NOW + 5),
    ).toEqual({ result: canonicalResult, status: "already_answered" });
    expect(
      store.answer(
        TEST_USER_ID,
        SESSION_ID,
        REQUEST_ID,
        { answers: [{ questionId: "decision", value: "stop" }] },
        TEST_NOW + 6,
      ),
    ).toBe("conflict");
    expect(
      database
        .select()
        .from(agentMessages)
        .all()
        .filter(({ role }) => role === "tool"),
    ).toHaveLength(1);
    expect(store.pending(TEST_USER_ID, SESSION_ID)).toBeNull();
    expect(store.recoverable()).toEqual([
      { id: SESSION_ID, userId: TEST_USER_ID },
    ]);
    expect(sessions.get(TEST_USER_ID, SESSION_ID)?.status).toBe("queued");
    database.$client.close();
  });

  test("rejects invalid answers and preserves the pending transaction", () => {
    const { database, sessions, store } = setup();
    store.create(
      TEST_USER_ID,
      SESSION_ID,
      "call-question",
      input,
      TEST_NOW + 2,
    );

    expect(() =>
      store.answer(
        TEST_USER_ID,
        SESSION_ID,
        REQUEST_ID,
        { answers: [{ questionId: "decision", value: "forged" }] },
        TEST_NOW + 3,
      ),
    ).toThrow("invalid");
    expect(store.pending(TEST_USER_ID, SESSION_ID)).not.toBeNull();
    expect(sessions.get(TEST_USER_ID, SESSION_ID)?.status).toBe("waiting");
    expect(
      database
        .select()
        .from(agentMessages)
        .all()
        .filter(({ role }) => role === "tool"),
    ).toHaveLength(0);
    database.$client.close();
  });

  test("does not recover later queued work from a historical answer", () => {
    const { database, sessions, store } = setup();
    store.create(
      TEST_USER_ID,
      SESSION_ID,
      "call-question",
      input,
      TEST_NOW + 2,
    );
    store.answer(TEST_USER_ID, SESSION_ID, REQUEST_ID, answers, TEST_NOW + 3);
    expect(
      store.startAnsweredSession(TEST_USER_ID, SESSION_ID, TEST_NOW + 4),
    ).toBe(true);
    sessions.appendAgentMessage(
      SESSION_ID,
      {
        content: "Finished after the answer",
        role: "assistant",
        toolCalls: [],
      },
      TEST_NOW + 5,
    );
    expect(sessions.mark(SESSION_ID, "idle", TEST_NOW + 6)).toBe(true);
    expect(sessions.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 7).status).toBe(
      "queued",
    );

    expect(store.recoverable()).toEqual([]);
    database.$client.close();
  });

  test("soft-deletes pending and answered requests when stopped", () => {
    const { database, store } = setup();
    store.create(
      TEST_USER_ID,
      SESSION_ID,
      "call-question",
      input,
      TEST_NOW + 2,
    );
    store.answer(TEST_USER_ID, SESSION_ID, REQUEST_ID, answers, TEST_NOW + 3);

    expect(store.cancel(TEST_USER_ID, SESSION_ID, TEST_NOW + 4)).toBe(true);
    expect(store.pending(TEST_USER_ID, SESSION_ID)).toBeNull();
    expect(database.select().from(agentQuestionRequests).get()).toMatchObject({
      answeredAt: new Date(TEST_NOW + 3),
      isDeleted: true,
      updatedById: TEST_USER_ID,
    });
    database.$client.close();
  });
});
/* jscpd:ignore-end */
