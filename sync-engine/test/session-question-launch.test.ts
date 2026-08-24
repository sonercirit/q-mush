import { describe, expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { agentQuestionRequests } from "../../shared/database/schema.ts";
import { MINIMUM_TOOL_OUTPUT_CHARACTERS } from "../../shared/tool-limits.ts";
import { unicodeCharacterCount } from "../../shared/tool-output-limits.ts";
import { TEST_QUESTION_OPTIONS } from "./ask-questions-test-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  startSessionAndCompleteAgentFile,
  waitForSessionStatus,
} from "./session-integration-helpers.ts";

const USER: AuthenticatedUser = {
  email: "mushroom@example.com",
  id: TEST_USER_ID,
  name: "Mush Room",
};
function questionCall(freeText = false) {
  return {
    arguments: JSON.stringify({
      questions: [
        freeText
          ? {
              id: "direction",
              maxLength: 4_000,
              prompt: "What next?",
              type: "free_text",
            }
          : {
              id: "direction",
              options: TEST_QUESTION_OPTIONS,
              prompt: "What next?",
              type: "single_choice",
            },
      ],
    }),
    id: "call-question",
    name: "ask_questions",
  };
}

function questionRequest(database: AppDatabase) {
  return database.select().from(agentQuestionRequests).get();
}

function answeringSetup(
  options: {
    readonly changedOutputLimitCharacters?: number;
    readonly freeText?: boolean;
    readonly outputLimitCharacters?: number;
    readonly refuseLaunch?: boolean;
  } = {},
) {
  let outputLimitCharacters = options.outputLimitCharacters ?? 20_000;
  let answerStarted = false;
  let answeredBeforeSettlement = false;
  let claimedBeforeResumedTurn = false;
  let credentialReads = 0;
  let drain: Promise<void> | undefined;
  const answer = Promise.withResolvers<unknown>();
  const model = createScriptedAgentModel(
    [
      {
        content: "I need a decision.",
        toolCalls: [questionCall(options.freeText)],
      },
      { content: "Continuing with the answer.", toolCalls: [] },
    ],
    {
      onComplete: (requestCount) => {
        if (requestCount === 2) {
          claimedBeforeResumedTurn =
            questionRequest(setup.database)?.isDeleted === true;
        }
      },
    },
  );
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    ...(options.outputLimitCharacters === undefined
      ? {}
      : {
          toolSettings: {
            read: () => ({
              executionLimitMinutes: 30,
              outputLimitCharacters,
            }),
          },
        }),
    onCredentialRead: () => {
      credentialReads += 1;
      if (options.refuseLaunch === true && credentialReads === 2) {
        drain = setup.sessions.drain();
      }
    },
    onChange: (userId, sessionId) => {
      const pending = setup.sessions.pendingQuestionForUser(userId, sessionId);
      if (pending === null || answerStarted) {
        return;
      }
      answerStarted = true;
      outputLimitCharacters =
        options.changedOutputLimitCharacters ?? outputLimitCharacters;
      const command = setup.sessions.realtimeCommands.answerQuestionsForUser(
        USER,
        {
          answers: [
            {
              questionId: "direction",
              value: options.freeText === true ? "😀".repeat(2_000) : "proceed",
            },
          ],
          requestId: pending.id,
          sessionId,
          workspaceId: TEST_WORKSPACE_ID,
        },
      );
      const activeRequest = questionRequest(setup.database);
      answeredBeforeSettlement =
        activeRequest?.answeredAt !== null &&
        activeRequest?.isDeleted === false;
      void command.then(answer.resolve, answer.reject);
    },
  });
  return {
    answer: answer.promise,
    answeredBeforeSettlement: () => answeredBeforeSettlement,
    claimedBeforeResumedTurn: () => claimedBeforeResumedTurn,
    drain: () => drain,
    setup,
  };
}

function expectAnsweredRequestState(
  testSetup: ReturnType<typeof answeringSetup>,
  launchStarted: boolean,
): Promise<void> {
  return expect(testSetup.answer).resolves.toMatchObject({
    launchStarted,
    status: "answered",
  });
}

function expectQuestionClaimState(
  testSetup: ReturnType<typeof answeringSetup>,
  claimed: boolean,
  expectedStatus?: string,
): void {
  expect(testSetup.answeredBeforeSettlement()).toBe(true);
  expect(testSetup.claimedBeforeResumedTurn()).toBe(claimed);
  expect(questionRequest(testSetup.setup.database)).toMatchObject({
    answeredAt: new Date(TEST_NOW),
    isDeleted: claimed,
  });
  if (expectedStatus !== undefined) {
    expect(
      testSetup.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    ).toMatchObject({ pendingQuestions: null, status: expectedStatus });
  }
}

async function settleAnsweredRun(
  testSetup: ReturnType<typeof answeringSetup>,
): Promise<void> {
  await startSessionAndCompleteAgentFile(testSetup.setup);
  await expectAnsweredRequestState(testSetup, true);
}

async function finishResumedRun(
  setup: ReturnType<typeof answeringSetup>["setup"],
): Promise<void> {
  await completeAgentFileLookup(setup);
  await waitForSessionStatus(setup, "idle");
}

describe("answered question launch claims", () => {
  test("claims after the old runtime settles and before resumed launch", async () => {
    const testSetup = answeringSetup();
    const { setup } = testSetup;

    await settleAnsweredRun(testSetup);
    await finishResumedRun(setup);

    expectQuestionClaimState(testSetup, true);
    setup.database.$client.close();
  });

  test("bounds an answered question result with the paused run snapshot", async () => {
    const testSetup = answeringSetup({
      changedOutputLimitCharacters: 20_000,
      freeText: true,
      outputLimitCharacters: MINIMUM_TOOL_OUTPUT_CHARACTERS,
    });
    const { setup } = testSetup;

    await settleAnsweredRun(testSetup);

    const result = setup.sessions
      .detailForUser(TEST_USER_ID, SESSION_ID)
      ?.messages.find(
        (message) =>
          message.role === "tool" && message.toolName === "ask_questions",
      )?.content;
    expect(result).toContain("Tool output truncated");
    expect(unicodeCharacterCount(result ?? "")).toBe(
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
    );

    await finishResumedRun(setup);
    expect(setup.selectedSystemPrompts).toHaveLength(2);
    expect(setup.selectedSystemPrompts[1]).toContain(
      `${MINIMUM_TOOL_OUTPUT_CHARACTERS.toLocaleString("en-US")} Unicode characters`,
    );
    expect(setup.selectedSystemPrompts[1]).not.toContain(
      "20,000 Unicode characters",
    );
    setup.database.$client.close();
  });

  test("reactivates the answer when the resumed launch is refused", async () => {
    const refused = answeringSetup({ refuseLaunch: true });
    const setup = refused.setup;

    await startSessionAndCompleteAgentFile(setup);
    await expectAnsweredRequestState(refused, false);

    await refused.drain();

    expectQuestionClaimState(refused, false, "queued");

    setup.database.$client.close();
  });
});
