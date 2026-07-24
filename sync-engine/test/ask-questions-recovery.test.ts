/* jscpd:ignore-start */
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import {
  agentMessages,
  agentQuestionRequests,
  agentSessions,
  runners,
} from "../../shared/database/schema.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import { createSessionIntegration } from "../../sync-engine/sessions.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  CREDENTIAL_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";

const REQUEST_ID = "018bcfe5-6800-7000-8000-000000000290";
const USER_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000291";
const ASSISTANT_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000292";
const TOOL_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000293";

function seedRestartedDatabase() {
  const database = createAuthenticatedTestDatabase();
  addTestProviderCredential(database, CREDENTIAL_ID);
  database
    .insert(runners)
    .values({
      ...testAuditFields(),
      architecture: "x64",
      id: RUNNER_ID,
      lastSeenAt: new Date(TEST_NOW),
      machineFingerprint: "recovery-machine",
      name: "workstation",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update("qmr_recovery-token")
        .digest("base64url"),
      userId: TEST_USER_ID,
    })
    .run();
  database
    .insert(agentSessions)
    .values({
      ...testAuditFields(),
      activeDurationMs: 20,
      id: SESSION_ID,
      model: "gpt-test",
      provider: "openai",
      providerCredentialId: CREDENTIAL_ID,
      runnerId: RUNNER_ID,
      status: "queued",
      title: "Recover questions",
      tools: JSON.stringify(AGENT_SESSION_TOOL_NAMES),
      userId: TEST_USER_ID,
      workingDirectory: "/work",
    })
    .run();
  database
    .insert(agentMessages)
    .values([
      {
        ...testAuditFields(),
        content: "Ask then continue",
        id: USER_MESSAGE_ID,
        role: "user",
        sessionId: SESSION_ID,
        userId: TEST_USER_ID,
      },
      {
        ...testAuditFields(),
        content: "Choose first.",
        id: ASSISTANT_MESSAGE_ID,
        role: "assistant",
        sessionId: SESSION_ID,
        toolCalls: JSON.stringify([
          {
            arguments: JSON.stringify({
              questions: [
                {
                  id: "direction",
                  options: [
                    { label: "Proceed", value: "proceed" },
                    { label: "Stop", value: "stop" },
                  ],
                  prompt: "What next?",
                  type: "single_choice",
                },
              ],
            }),
            id: "call-question",
            name: "ask_questions",
          },
        ]),
        userId: TEST_USER_ID,
      },
      {
        ...testAuditFields(),
        content:
          '{\n  "answers": [\n    {\n      "questionId": "direction",\n      "value": "proceed"\n    }\n  ]\n}',
        id: TOOL_MESSAGE_ID,
        role: "tool",
        sessionId: SESSION_ID,
        toolCallId: "call-question",
        toolName: "ask_questions",
        userId: TEST_USER_ID,
      },
    ])
    .run();
  database
    .insert(agentQuestionRequests)
    .values({
      ...testAuditFields(),
      answeredAt: new Date(TEST_NOW),
      answers: JSON.stringify({
        answers: [{ questionId: "direction", value: "proceed" }],
      }),
      id: REQUEST_ID,
      questions: JSON.stringify({
        questions: [
          {
            id: "direction",
            options: [
              { label: "Proceed", value: "proceed" },
              { label: "Stop", value: "stop" },
            ],
            prompt: "What next?",
            type: "single_choice",
          },
        ],
      }),
      sessionId: SESSION_ID,
      toolCallId: "call-question",
      userId: TEST_USER_ID,
    })
    .run();
  return database;
}

test("recovers an answered question after restart when the runner reconnects", async () => {
  const database = seedRestartedDatabase();
  const auth = createGoogleAuthFromEnvironment(
    {},
    { database, now: () => TEST_NOW },
  );
  const runnersIntegration = createRunnerIntegration(auth, {
    database,
    now: () => TEST_NOW,
  });
  const credential: ProviderCredentialAccess = {
    accountId: null,
    id: CREDENTIAL_ID,
    isDefault: false,
    label: "key",
    secret: "secret",
    source: "api_key",
  };
  const reader = { readCredential: () => credential };
  const model = new ScriptedAgentModel([
    { content: "Recovered and continued.", toolCalls: [] },
  ]);
  const broker = new RunnerCommandBroker({
    deliver: (runnerId, command) => {
      queueMicrotask(() => {
        broker.complete(runnerId, command.id, "null");
      });
      return true;
    },
  });
  const sessions = createSessionIntegration(
    auth,
    runnersIntegration,
    { openai: reader, openrouter: reader },
    {
      braveSearch: { execute: () => Promise.resolve("unused") },
      broker,
      database,
      modelFactory: () => model,
      now: () => TEST_NOW,
      randomId: () => "018bcfe5-6800-7000-8000-000000000294",
    },
  );

  const connected = runnersIntegration.connect("qmr_recovery-token", {
    architecture: "x64",
    machineFingerprint: "recovery-machine",
    name: "workstation",
    platform: "linux",
  });
  if (connected === undefined) {
    throw new Error("The recovery runner did not connect");
  }
  runnersIntegration.seen(connected.connection);
  sessions.runnerConnected();
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status === "idle") {
      break;
    }
    await Bun.sleep(1);
  }

  const finalDetail = sessions.detailForUser(TEST_USER_ID, SESSION_ID);
  expect(finalDetail).toMatchObject({
    pendingQuestions: null,
    status: "idle",
  });
  const firstRequest: readonly AgentConversationMessage[] | undefined =
    model.requests[0];
  expect(firstRequest).toBeDefined();
  expect(
    firstRequest?.some(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "call-question" &&
        message.toolName === "ask_questions" &&
        message.content.includes('"value": "proceed"'),
    ),
  ).toBe(true);
  database.$client.close();
});
/* jscpd:ignore-end */
