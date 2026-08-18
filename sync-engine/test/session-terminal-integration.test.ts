import { expect, test } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import {
  RunnerCommandBroker,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import {
  createAuthenticatedRequest,
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { terminalAgentStep } from "./deferred-agent-model.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { spawnCall } from "./session-agent-spawn-helpers.ts";
import { toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  createStartedDeferredSession,
  expectDrainedTerminalSession,
  expectSingleModelRequest,
  expectSingleTranscriptOccurrence,
  hasSessionStatus,
  reconnectRunnerAndExpectNoReplay,
  startSessionAndCompleteAgentFile,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

function parentSessionRequests(
  requests: readonly AgentConversationMessage[][],
): readonly AgentConversationMessage[][] {
  return requests.filter((messages) => {
    const request = messages[0];
    return request?.content === "Inspect README.md";
  });
}

class PrefillRejectingSleepWakeCallbackModel implements AgentModel {
  readonly #childCompletion = Promise.withResolvers<undefined>();
  readonly #sleepStep = Promise.withResolvers<undefined>();
  readonly requests: AgentConversationMessage[][] = [];

  readonly complete = async (
    ...parameters: Parameters<AgentModel["complete"]>
  ) => {
    const [messages] = parameters;
    const copied = messages.map((message) => ({ ...message }));
    this.requests.push(copied);
    const initial = messages[0]?.content;
    if (initial === "Complete during the parent sleep") {
      await this.#childCompletion.promise;
      return terminalAgentStep(
        messages.at(-1)?.content === "Continue."
          ? "Continued child result."
          : "Child callback result.",
      );
    }
    const parentRequest = parentSessionRequests(this.requests).length;
    if (parentRequest === 1) {
      return providerStep("Delegating before sleeping.", {
        toolCalls: [spawnCall("Complete during the parent sleep")],
      });
    }
    if (parentRequest === 2) {
      this.#sleepStep.resolve();
      return providerStep("Waiting for the child callback.", {
        toolCalls: [toolCall("sleep", { durationSeconds: 60 })],
      });
    }
    if (messages.at(-1)?.role !== "user") {
      throw new Error(
        "This model does not support assistant message prefill. The conversation must end with a user message.",
      );
    }
    return terminalAgentStep("Callback handled once.");
  };

  finishChild(): void {
    this.#childCompletion.resolve();
  }

  waitForSleepStep(): Promise<undefined> {
    return this.#sleepStep.promise;
  }
}

function completeBrokerCommand(
  broker: RunnerCommandBroker,
  runnerId: string,
  command: RunnerToolCommand,
): void {
  const accepted = broker.complete(runnerId, command.id, {
    output: String(null),
    state: "completed",
  });
  if (!accepted) throw new Error("The test command was not pending");
}

function autoCompletingAgentFileBroker(): {
  readonly broker: RunnerCommandBroker;
  readonly commands: readonly RunnerToolCommand[];
} {
  const commands: RunnerToolCommand[] = [];
  let commandSequence = 0;
  const broker = new RunnerCommandBroker({
    commandId: () => `phantom-step-command-${String(++commandSequence)}`,
    deliver: (runnerId, command) => {
      commands.push(command);
      if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
        queueMicrotask(() => {
          completeBrokerCommand(broker, runnerId, command);
        });
      }
      return true;
    },
  });
  return { broker, commands };
}

class PrefillRejectingSteeringModel implements AgentModel {
  readonly #firstStep = Promise.withResolvers<AgentModelStep>();
  readonly requests: AgentConversationMessage[][] = [];

  readonly complete = (
    ...parameters: Parameters<AgentModel["complete"]>
  ): Promise<AgentModelStep> => {
    const [messages] = parameters;
    const request = messages.slice();
    this.requests.push(request);
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

test("does not relaunch after consuming a sleep-wake child callback", async () => {
  const model = new PrefillRejectingSleepWakeCallbackModel();
  const { broker, commands } = autoCompletingAgentFileBroker();
  const setup = connectedSessionSetup(model, "api_key", undefined, { broker });

  const initialRequest = setup.sessions.collection(createSessionRequest());
  expect((await initialRequest).status).toBe(201);
  await model.waitForSleepStep();
  const readParent = () =>
    setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
  const sleeping = await waitForSessionValue(readParent, (value) => {
    const detail = isRecord(value) ? value : {};
    return JSON.stringify(detail).includes("Waiting for the child callback.");
  });
  expect(isRecord(sleeping)).toBe(true);
  model.finishChild();

  const readChild = () => {
    const children = setup.sessions.listForUser(TEST_USER_ID);
    return children.find(
      ({ title }) => title === "Complete during the parent sleep",
    );
  };
  const completedChild = await waitForSessionValue(
    readChild,
    hasSessionStatus("completed"),
  );
  expect(completedChild).toMatchObject({ status: "completed" });

  const parentIsTerminal = (value: unknown) => {
    if (!isRecord(value)) return false;
    if (value["status"] === "failed") return true;
    return (
      value["status"] === "idle" &&
      JSON.stringify(value).includes("Callback handled once.")
    );
  };
  const terminal = await waitForSessionValue(readParent, parentIsTerminal);
  await Promise.resolve();
  const settled = readParent();
  const parentRequests = parentSessionRequests(model.requests);

  expect(terminal).toMatchObject({ status: "idle" });
  expect(settled).toMatchObject({ pendingInputs: [], status: "idle" });
  expect(parentRequests).toHaveLength(3);
  const callbackMessages =
    settled?.messages.filter(({ content }) =>
      content.includes("Spawned session completed"),
    ) ?? [];
  expect(callbackMessages).toHaveLength(1);
  expect(callbackMessages[0]?.content).toContain("Child callback result.");
  expect(callbackMessages[0]?.content).toContain('"role": "assistant"');

  if (!isRecord(completedChild) || typeof completedChild["id"] !== "string") {
    throw new Error("The completed child is unavailable");
  }
  const continued = await setup.sessions.continue(
    createAuthenticatedRequest(
      `${SESSIONS_PATH}/${completedChild["id"]}/continue`,
      undefined,
      "POST",
    ),
    completedChild["id"],
  );
  expect(continued.status).toBe(202);
  const continuedChild = await waitForSessionValue(
    readChild,
    (value) =>
      hasSessionStatus("idle")(value) &&
      isRecord(value) &&
      value["generation"] === 1,
  );
  expect(continuedChild).toMatchObject({
    generation: 1,
    parentExecutionGeneration: 0,
    parentSessionId: SESSION_ID,
    status: "idle",
  });
  const continuedChildDetail = setup.sessions.detailForUser(
    TEST_USER_ID,
    completedChild["id"],
  );
  expect(
    continuedChildDetail?.messages.filter(
      ({ content }) => content === "Continued child result.",
    ),
  ).toHaveLength(1);
  expect(parentSessionRequests(model.requests)).toHaveLength(3);
  expect(
    readParent()?.messages.filter(({ content }) =>
      content.includes("Spawned session completed"),
    ),
  ).toHaveLength(1);
  expect(
    commands.filter(
      ({ sessionId, tool }) =>
        sessionId === SESSION_ID && tool === RUNNER_AGENT_FILE_COMMAND,
    ),
  ).toHaveLength(1);
  setup.database.$client.close();
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
