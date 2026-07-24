import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { findToolResultContent } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  QUESTION_REQUEST_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

describe("ask_questions agent tool", () => {
  /* jscpd:ignore-start */
  test("pauses and resumes with canonical idempotent answers", async () => {
    const model = scriptedModel([
      {
        content: "I need a decision.",
        toolCalls: [
          toolCall("ask_questions", {
            questions: [
              {
                id: "direction",
                options: [
                  { label: "Proceed", value: "proceed" },
                  { label: "Stop", value: "stop" },
                ],
                prompt: "What should I do?",
                type: "single_choice",
              },
            ],
          }),
        ],
      },
      { content: "Proceeding with your choice.", toolCalls: [] },
    ]);
    const setup = await startToolSession(model);
    const waiting = await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("waiting"),
    );
    expect(waiting).toMatchObject({
      pendingQuestions: {
        id: QUESTION_REQUEST_ID,
        toolCallId: "call-ask_questions",
      },
    });
    expect(JSON.stringify(waiting)).not.toContain(
      "interrupted before it returned",
    );

    const answerPath = "/api/sessions/session/questions/request/answer";
    const answer = { answers: [{ questionId: "direction", value: "proceed" }] };
    const unauthorized = await setup.sessions.answerQuestions(
      new Request(`http://localhost${answerPath}`, {
        body: JSON.stringify(answer),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      SESSION_ID,
      QUESTION_REQUEST_ID,
    );
    expect(unauthorized.status).toBe(401);

    const first = await setup.sessions.answerQuestions(
      createAuthenticatedRequest(answerPath, answer, "POST"),
      SESSION_ID,
      QUESTION_REQUEST_ID,
    );
    expect(first.status).toBe(200);
    const repeated = await setup.sessions.answerQuestions(
      createAuthenticatedRequest(answerPath, answer, "POST"),
      SESSION_ID,
      QUESTION_REQUEST_ID,
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ pendingQuestions: null });
    const conflicting = await setup.sessions.answerQuestions(
      createAuthenticatedRequest(
        answerPath,
        { answers: [{ questionId: "direction", value: "stop" }] },
        "POST",
      ),
      SESSION_ID,
      QUESTION_REQUEST_ID,
    );
    expect(conflicting.status).toBe(409);

    await completeAgentFileLookup(setup);
    const complete = await completedParentDetail(setup, "idle");
    expect(findToolResultContent(complete, "ask_questions")).toContain(
      '"value": "proceed"',
    );
    expect(JSON.stringify(complete)).toContain("Proceeding with your choice.");
    expect(
      setup.sessions.listForUser(TEST_USER_ID)[0]?.pendingQuestions,
    ).toBeNull();
    setup.database.$client.close();
  });

  test("soft-cancels a pending request when stopped", async () => {
    const model = scriptedModel([
      {
        content: "Please choose.",
        toolCalls: [
          toolCall("ask_questions", {
            questions: [
              {
                id: "note",
                maxLength: 20,
                prompt: "Add a note",
                type: "free_text",
              },
            ],
          }),
        ],
      },
    ]);
    const setup = await startToolSession(model);
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("waiting"),
    );

    const stopped = await setup.sessions.stop(
      createAuthenticatedRequest(
        "/api/sessions/session/stop",
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(await stopped.json()).toMatchObject({
      pendingQuestions: null,
      status: "stopped",
    });
    setup.database.$client.close();
  });

  test("rejects a forged nested call", async () => {
    const model = scriptedModel([
      {
        content: "Trying a blocking parallel call.",
        toolCalls: [
          toolCall("parallel", {
            tool_uses: [
              { parameters: {}, recipient_name: "list_sessions" },
              {
                parameters: {
                  questions: [
                    {
                      id: "nested",
                      maxLength: 10,
                      prompt: "Should not render",
                      type: "free_text",
                    },
                  ],
                },
                recipient_name: "ask_questions",
              },
            ],
          }),
        ],
      },
      { content: "Nested question rejected.", toolCalls: [] },
    ]);
    const setup = await startToolSession(model);
    const detail = await completedParentDetail(setup, "idle");
    const output = findToolResultContent(detail, "parallel");

    expect(isRecord(detail)).toBe(true);
    expect(output).toContain("ask_questions cannot run inside parallel");
    expect(
      setup.sessions.listForUser(TEST_USER_ID)[0]?.pendingQuestions,
    ).toBeNull();
    setup.database.$client.close();
  });
  /* jscpd:ignore-end */
});
