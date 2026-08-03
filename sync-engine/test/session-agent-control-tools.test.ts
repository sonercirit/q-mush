import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  completedParentDetail,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import { unusedSessionToolActions } from "./session-agent-tool-test-helpers.ts";
import { readManualCompactionRows } from "./session-compaction-test-helpers.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const COMPACTION_INSTRUCTION =
  "Compact this conversation now. Return only the handoff summary.";

function isCompactionRequest(input: readonly AgentConversationMessage[]) {
  return input.at(-1)?.content === COMPACTION_INSTRUCTION;
}

function scheduledCompactionStep(
  content: string,
  callId = "call-compact_session",
): AgentModelStep {
  return providerStep(content, {
    toolCalls: [toolCall("compact_session", { sessionId: SESSION_ID }, callId)],
  });
}

class SelfCompactingModel implements AgentModel {
  #step = 0;

  complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    this.#step += 1;
    const response = isCompactionRequest(input)
      ? providerStep("Self-compaction handoff")
      : this.#step === 1
        ? scheduledCompactionStep("I will compact at this step boundary.")
        : providerStep("Continued after self-compaction.");
    return Promise.resolve(response);
  }
}

class RestartScheduledCompactionModel implements AgentModel {
  readonly compacting = Promise.withResolvers<undefined>();
  #scheduled = false;

  complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    if (isCompactionRequest(input)) {
      this.compacting.resolve();
      return successfulCompactionStep("Restart-safe compacted handoff.");
    }
    if (!this.#scheduled) {
      this.#scheduled = true;
      return Promise.resolve(
        providerStep("Schedule before restart.", {
          toolCalls: [
            toolCall("compact_session", { sessionId: SESSION_ID }),
            toolCall(
              "bash",
              { command: "printf restart-gap", timeout: 30 },
              "call-restart-gap",
            ),
          ],
        }),
      );
    }
    return Promise.resolve(providerStep("Continued after restart compaction."));
  }
}

function failedCompactionStep(): Promise<AgentModelStep> {
  return Promise.reject(new Error("Generation-zero compactor failed"));
}

function successfulCompactionStep(content: string): Promise<AgentModelStep> {
  return Promise.resolve(providerStep(content));
}

class FailedThenRetriedCompactionModel implements AgentModel {
  compactionRequests = 0;
  #agentSteps = 0;

  complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    if (!isCompactionRequest(input)) {
      return this.#agentStep();
    }
    this.compactionRequests += 1;
    if (this.compactionRequests === 1) {
      return failedCompactionStep();
    }
    if (this.compactionRequests === 2) {
      return successfulCompactionStep("Generation-one handoff.");
    }
    throw new Error("Unexpected repeated compaction");
  }

  #agentStep(): Promise<AgentModelStep> {
    this.#agentSteps += 1;
    return Promise.resolve(
      this.#agentSteps === 3
        ? providerStep("Continued exactly once.")
        : scheduledCompactionStep(
            `Schedule generation ${String(this.#agentSteps - 1)}.`,
            `call-compact-generation-${String(this.#agentSteps - 1)}`,
          ),
    );
  }
}

class SteeringDispatchModel implements AgentModel {
  readonly releaseTarget = Promise.withResolvers<undefined>();
  readonly targetWaiting = Promise.withResolvers<undefined>();
  readonly targetRequests: AgentConversationMessage[][] = [];
  #parentStep = 0;
  #targetStarted = false;

  async complete(messages: readonly AgentConversationMessage[]) {
    const steeringText = JSON.stringify(messages);
    if (steeringText.includes("Running steering target.")) {
      this.targetRequests.push([...messages]);
      if (steeringText.includes("Change direction at the boundary.")) {
        return providerStep("Steering consumed.");
      }
      if (this.#targetStarted) {
        throw new Error("The steering target repeated its initial request");
      }
      this.#targetStarted = true;
      this.targetWaiting.resolve();
      await this.releaseTarget.promise;
      return providerStep("Reached the steering boundary.");
    }
    if (steeringText.includes("Dispatch steering from the real tool mount.")) {
      this.#parentStep += 1;
      return this.#parentStep === 1
        ? providerStep("Steer the running target.", {
            toolCalls: [
              toolCall("steer_session", {
                message: "Change direction at the boundary.",
                sessionId: SESSION_ID,
              }),
            ],
          })
        : providerStep("Steering dispatch complete.");
    }
    throw new Error("Unexpected steering model request");
  }
}

class CompletedTargetCompactionModel implements AgentModel {
  #parentStep = 0;

  complete(messages: readonly AgentConversationMessage[]) {
    const compactingText = JSON.stringify(messages);
    if (isCompactionRequest(messages)) {
      return Promise.resolve(providerStep("Completed target handoff."));
    }
    if (compactingText.includes("Completed target handoff.")) {
      return Promise.resolve(providerStep("Completed target continued."));
    }
    if (compactingText.includes("Completed compaction target.")) {
      return Promise.resolve(
        providerStep("Target completed before compaction."),
      );
    }
    if (compactingText.includes("Compact the completed target.")) {
      this.#parentStep += 1;
      return Promise.resolve(
        this.#parentStep === 1
          ? providerStep("Compact completed target.", {
              toolCalls: [
                toolCall("compact_session", { sessionId: SESSION_ID }),
              ],
            })
          : providerStep("Completed target compaction dispatched."),
      );
    }
    throw new Error("Unexpected completed-target model request");
  }
}

type ConnectedSetup = ReturnType<typeof connectedSessionSetup>;

function commandIds(): () => string {
  let index = 0;
  return () => `agent-control-command-${String((index += 1))}`;
}

async function sessionRequest(prompt: string): Promise<Request> {
  const input: unknown = await createSessionRequest().json();
  if (!isRecord(input)) {
    throw new TypeError("The session request fixture is invalid");
  }
  return createAuthenticatedRequest(
    `${SESSIONS_PATH}?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
    { ...input, prompt },
    "POST",
  );
}

async function continueSession(setup: ConnectedSetup): Promise<Response> {
  const url = `${SESSIONS_PATH}/${SESSION_ID}/continue`;
  return setup.sessions.continue(
    createAuthenticatedRequest(url, undefined, "POST"),
    SESSION_ID,
  );
}

async function createPromptSession(
  setup: ConnectedSetup,
  prompt: string,
): Promise<string> {
  const response = await setup.sessions.collection(
    await sessionRequest(prompt),
  );
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value["id"] !== "string") {
    throw new TypeError("The created session response is invalid");
  }
  return value["id"];
}

async function expectCreatedDefaultSession(
  setup: ConnectedSetup,
): Promise<void> {
  expect((await setup.sessions.collection(createSessionRequest())).status).toBe(
    201,
  );
}

async function expectCreatedPromptSession(
  setup: ConnectedSetup,
  prompt: string,
): Promise<void> {
  expect(await createPromptSession(setup, prompt)).toBe(SESSION_ID);
}

async function takeRunnerCommand(
  setup: ConnectedSetup,
  sessionId: string,
  tool: string,
) {
  const command = await waitForSessionValue(
    () =>
      setup.runnerCommands.find(
        (candidate) =>
          candidate.sessionId === sessionId && candidate.tool === tool,
      ),
    (value) => value !== undefined,
  );
  if (!isRecord(command) || typeof command["id"] !== "string") {
    throw new TypeError("The expected runner command is unavailable");
  }
  const index = setup.runnerCommands.findIndex(
    ({ id }) => id === command["id"],
  );
  if (index >= 0) setup.runnerCommands.splice(index, 1);
  return command["id"];
}

async function completeRunnerCommand(
  setup: ConnectedSetup,
  sessionId: string,
  tool: string,
  output = "null",
): Promise<void> {
  const commandId = await takeRunnerCommand(setup, sessionId, tool);
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, commandId, {
      output,
      state: "completed",
    }),
  ).toBe(true);
}

function operationRows(setup: ConnectedSetup, sessionId = SESSION_ID) {
  return readManualCompactionRows(setup.database, sessionId);
}

function controlledSetup(model: AgentModel): ConnectedSetup {
  return connectedSessionSetup(model, "api_key", undefined, {
    commandId: commandIds(),
  });
}

function recreatedSetup(model: AgentModel, initial: ConnectedSetup) {
  const { database } = initial;
  return connectedSessionSetup(model, "api_key", undefined, { database });
}

async function completeAndWaitForSession(
  setup: ConnectedSetup,
  sessionId: string,
  content: string,
) {
  await completeRunnerCommand(setup, sessionId, RUNNER_AGENT_FILE_COMMAND);
  return completedSessionContaining(setup, sessionId, content);
}

function markSessionCompleted(setup: ConnectedSetup): void {
  setup.database
    .update(agentSessions)
    .set({ status: "completed" })
    .where(eq(agentSessions.id, SESSION_ID))
    .run();
}

async function waitForSessionStatus(
  setup: ConnectedSetup,
  sessionId: string,
  status: string,
): Promise<unknown> {
  return waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, sessionId),
    hasSessionStatus(status),
  );
}

async function completedSessionContaining(
  setup: ConnectedSetup,
  sessionId: string,
  content: string,
) {
  return waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, sessionId),
    (value) =>
      hasSessionStatus("idle")(value) &&
      JSON.stringify(value).includes(content),
  );
}

test("rejects invalid compact and steer dispatch arguments", async () => {
  const outputs = await Promise.all([
    executeSessionAgentTool(unusedSessionToolActions(), "compact_session", {
      sessionId: SESSION_ID,
      unexpected: true,
    }),
    executeSessionAgentTool(unusedSessionToolActions(), "steer_session", {
      message: "",
      sessionId: SESSION_ID,
    }),
  ]);

  expect(outputs[0].output).toContain("invalid arguments");
  expect(outputs[1].output).toContain("message is invalid");
});

test("self-compaction schedules at the tool boundary and continues", async () => {
  const setup = await startToolSession(new SelfCompactingModel());
  const detail = await completedParentDetail(setup, "idle");
  const serialized = JSON.stringify(detail);

  expect(serialized).toContain("Self-compaction handoff");
  expect(serialized).toContain("Continued after self-compaction.");
  closeSessionTestDatabase(setup.database);
});

test("scheduled self-compaction survives restart before its boundary", async () => {
  const model = new RestartScheduledCompactionModel();
  const initial = controlledSetup(model);
  await expectCreatedDefaultSession(initial);
  await completeRunnerCommand(initial, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  const restartGapCommand = await takeRunnerCommand(
    initial,
    SESSION_ID,
    "bash",
  );
  const beforeRestart = initial.sessions.detailForUser(
    TEST_USER_ID,
    SESSION_ID,
  );
  expect(JSON.stringify(beforeRestart)).toContain("compaction_scheduled");

  const drain = initial.sessions.drain();
  expect(
    initial.sessions.completeRunnerCommand(RUNNER_ID, restartGapCommand, {
      output: "restart gap complete",
      state: "completed",
    }),
  ).toBe(true);
  await drain;
  expect(
    initial.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
  ).toMatchObject({
    restartHandoff: { operation: "compact_and_continue" },
    status: "paused",
  });

  const recreated = recreatedSetup(model, initial);
  await completeRunnerCommand(recreated, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  await model.compacting.promise;
  await completeRunnerCommand(recreated, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  const continued = await completedSessionContaining(
    recreated,
    SESSION_ID,
    "Continued after restart compaction.",
  );
  expect(JSON.stringify(continued)).toContain(
    "Restart-safe compacted handoff.",
  );
  expect(operationRows(recreated)[0]?.deleted).toBe(true);
  closeSessionTestDatabase(initial.database);
});

test("retires a failed scheduled generation before retrying compaction", async () => {
  const model = new FailedThenRetriedCompactionModel();
  const setup = controlledSetup(model);
  await expectCreatedDefaultSession(setup);
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  await waitForSessionStatus(setup, SESSION_ID, "failed");
  expect(operationRows(setup)[0]?.deleted).toBe(true);

  const continued = await continueSession(setup);
  expect(continued.status).toBe(202);
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  const settled = await completedSessionContaining(
    setup,
    SESSION_ID,
    "Continued exactly once.",
  );

  expect(model.compactionRequests).toBe(2);
  expect(JSON.stringify(settled)).toContain("Generation-one handoff.");
  expect(operationRows(setup)).toEqual([
    { deleted: true, generation: 0 },
    { deleted: true, generation: 1 },
  ]);
  closeSessionTestDatabase(setup.database);
});

test("steer_session dispatch is consumed by a running target at its boundary", async () => {
  const model = new SteeringDispatchModel();
  const setup = controlledSetup(model);
  await expectCreatedPromptSession(setup, "Running steering target.");
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  await model.targetWaiting.promise;

  const parentId = await createPromptSession(
    setup,
    "Dispatch steering from the real tool mount.",
  );
  await completeRunnerCommand(setup, parentId, RUNNER_AGENT_FILE_COMMAND);
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, parentId),
    (value) => JSON.stringify(value).includes("steering_scheduled"),
  );
  model.releaseTarget.resolve();
  const target = await completeAndWaitForSession(
    setup,
    SESSION_ID,
    "Steering consumed.",
  );
  expect(JSON.stringify(target)).toContain("Change direction at the boundary.");
  expect(
    model.targetRequests.some((request) =>
      JSON.stringify(request).includes("Change direction at the boundary."),
    ),
  ).toBe(true);
  closeSessionTestDatabase(setup.database);
});

test("compact_session wakes a completed target, compacts, and continues it", async () => {
  const model = new CompletedTargetCompactionModel();
  const setup = controlledSetup(model);
  await expectCreatedPromptSession(setup, "Completed compaction target.");
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  await waitForSessionStatus(setup, SESSION_ID, "idle");
  markSessionCompleted(setup);

  const parentId = await createPromptSession(
    setup,
    "Compact the completed target.",
  );
  await completeRunnerCommand(setup, parentId, RUNNER_AGENT_FILE_COMMAND);
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  expect(setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status).toBe(
    "running",
  );
  const target = await completeAndWaitForSession(
    setup,
    SESSION_ID,
    "Completed target continued.",
  );
  const serialized = JSON.stringify(target);
  expect(serialized).toContain("Completed target handoff.");
  expect(serialized).not.toContain("Target completed before compaction.");
  closeSessionTestDatabase(setup.database);
});
