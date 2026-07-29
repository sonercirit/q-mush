import { expect, test } from "vitest";
import {
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { terminalAgentTurn } from "./deferred-agent-model.ts";
import {
  connectedSessionSetup,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  createStartedDeferredSession,
  expectDrainedTerminalSession,
  expectSingleModelRequest,
  expectSingleTranscriptOccurrence,
  reconnectRunnerAndExpectNoReplay,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

test("settles one deferred terminal answer without a restart handoff", async () => {
  await expectDrainedTerminalSession(async ({ model, setup, terminal }) => {
    expect(terminal).toMatchObject({
      messages: [
        { role: "user" },
        { content: "One durable answer.", role: "assistant" },
      ],
      restartHandoff: null,
      status: "idle",
    });

    expectSingleTranscriptOccurrence(terminal, "One durable answer.");
    expectSingleModelRequest(model);

    const recreated = connectedSessionSetup(model, "api_key", undefined, {
      database: setup.database,
    });

    await reconnectRunnerAndExpectNoReplay(recreated, model, RUNNER_ID);
  });
});

test("commits a terminal follow-up before relaunching after runtime deregistration", async () => {
  const { created, model, setup } = await createStartedDeferredSession();
  expect(created.status).toBe(201);
  const running = setup.sessions.detailForUser(
    TEST_USER_ID,
    SESSION_ID,
    TEST_WORKSPACE_ID,
  );
  if (running === undefined) {
    throw new Error("The running terminal follow-up session is unavailable");
  }
  const command = setup.sessions.realtimeCommands.pendingInputForUser(
    TEST_AUTHENTICATED_USER,
    {
      clientRequestId: "terminal-follow-up-request",
      images: [],
      kind: "follow_up",
      prompt: "Continue after the first answer",
      sessionId: running.id,
    },
    running.workspaceId,
  );
  expect(command).toMatchObject({
    pendingInputs: [{ content: "Continue after the first answer" }],
    status: "running",
  });

  model.resolve(terminalAgentTurn("First durable answer."));
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () => model.requests.length,
    (requests) => requests === 2,
  );
  const continued = setup.sessions.detailForUser(
    TEST_USER_ID,
    SESSION_ID,
    TEST_WORKSPACE_ID,
  );
  const turns = continued?.turns ?? [];
  const firstAnswer = continued?.messages.find(
    ({ content }) => content === "First durable answer.",
  );
  const promotedFollowUp = continued?.messages.find(
    ({ content }) => content === "Continue after the first answer",
  );
  const closingTurn = turns.find(({ id }) => id === firstAnswer?.turnId);
  const successorTurn = turns.find(({ id }) => id === promotedFollowUp?.turnId);
  const closingBoundary = continued?.messages.find(
    ({ id }) => id === closingTurn?.boundaryMessageId,
  );
  expect(successorTurn).toBeDefined();
  expect(promotedFollowUp?.turnId).not.toBe(closingTurn?.id);
  expect(closingBoundary?.turnId).toBe(closingTurn?.id);
  expect(closingBoundary?.id).not.toBe(promotedFollowUp?.id);
  setup.database.$client.close();
  const followUp = model.requests[1];
  expect(followUp).toContainEqual({
    content: "Continue after the first answer",
    role: "user",
  });
});
