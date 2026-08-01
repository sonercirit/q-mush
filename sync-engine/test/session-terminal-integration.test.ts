import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { terminalAgentStep } from "./deferred-agent-model.ts";
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
  startSessionAndCompleteAgentFile,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

class PrefillRejectingSteeringModel implements AgentModel {
  readonly #firstStep = Promise.withResolvers<AgentModelStep>();
  readonly requests: AgentConversationMessage[][] = [];

  readonly complete = (
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> => {
    this.requests.push([...messages]);
    if (this.requests.length === 1) {
      return this.#firstStep.promise;
    }
    if (messages.at(-1)?.role !== "user") {
      return Promise.reject(
        new Error(
          "This model does not support assistant message prefill. The conversation must end with a user message.",
        ),
      );
    }
    return Promise.resolve(terminalAgentStep("Steer handled safely."));
  };

  resolveFirstStep(): void {
    this.#firstStep.resolve(
      terminalAgentStep("Answer completed before steering."),
    );
  }
}

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

test("orders a mid-step steer after the in-flight assistant output", async () => {
  const model = new PrefillRejectingSteeringModel();
  const setup = connectedSessionSetup(model);
  const created = await startSessionAndCompleteAgentFile(setup);
  expect(created.status).toBe(201);
  await waitForSessionValue(
    () => model.requests[0],
    (request) => request !== undefined,
  );

  const command = setup.sessions.realtimeCommands.pendingInputForUser(
    TEST_AUTHENTICATED_USER,
    {
      clientRequestId: "mid-step-steer-request",
      images: [],
      kind: "steer",
      prompt: "Use the safer direction.",
      sessionId: SESSION_ID,
    },
    TEST_WORKSPACE_ID,
  );
  expect(command).toMatchObject({
    pendingInputs: [{ content: "Use the safer direction." }],
    status: "running",
  });

  model.resolveFirstStep();
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () =>
      setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID, TEST_WORKSPACE_ID),
    (value) =>
      isRecord(value) &&
      (value["status"] === "failed" ||
        (value["status"] === "idle" && model.requests.length === 2)),
  );
  const terminal = setup.sessions.detailForUser(
    TEST_USER_ID,
    SESSION_ID,
    TEST_WORKSPACE_ID,
  );

  expect(terminal?.status).toBe("idle");
  expect(
    terminal?.messages.map((message) => [message.role, message.content]),
  ).toEqual([
    ["user", "Inspect README.md"],
    ["assistant", "Answer completed before steering."],
    ["user", "Use the safer direction."],
    ["assistant", "Steer handled safely."],
  ]);
  expect(model.requests).toHaveLength(2);
  const steeringRequest = model.requests[1]?.at(-1);
  expect(steeringRequest?.role).toBe("user");
  expect(steeringRequest?.content).toBe("Use the safer direction.");
  setup.database.$client.close();
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

  model.resolve(terminalAgentStep("First durable answer."));
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
