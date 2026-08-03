import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  agentSessionOperations,
  agentSessions,
} from "../../shared/database/schema.ts";
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

class SelfCompactingModel implements AgentModel {
  #step = 0;

  complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    this.#step += 1;
    const response = isCompactionRequest(input)
      ? { content: "Self-compaction handoff", toolCalls: [] }
      : this.#step === 1
        ? {
            content: "I will compact at this step boundary.",
            toolCalls: [toolCall("compact_session", { sessionId: SESSION_ID })],
          }
        : { content: "Continued after self-compaction.", toolCalls: [] };
    return Promise.resolve(providerStep(response.content, response));
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
      return Promise.resolve(providerStep("Restart-safe compacted handoff."));
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

class SteeringDispatchModel implements AgentModel {
  readonly releaseTarget = Promise.withResolvers<undefined>();
  readonly targetWaiting = Promise.withResolvers<undefined>();
  readonly targetRequests: AgentConversationMessage[][] = [];
  #parentStep = 0;
  #targetStarted = false;

  async complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    const text = JSON.stringify(input);
    if (text.includes("Running steering target.")) {
      this.targetRequests.push([...input]);
      if (text.includes("Change direction at the boundary.")) {
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
    if (text.includes("Dispatch steering from the real tool mount.")) {
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

  complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    const text = JSON.stringify(input);
    if (isCompactionRequest(input)) {
      return Promise.resolve(providerStep("Completed target handoff."));
    }
    if (text.includes("Completed target handoff.")) {
      return Promise.resolve(providerStep("Completed target continued."));
    }
    if (text.includes("Completed compaction target.")) {
      return Promise.resolve(
        providerStep("Target completed before compaction."),
      );
    }
    if (text.includes("Compact the completed target.")) {
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

function recreatedSetup(model: AgentModel, initial: ConnectedSetup) {
  return connectedSessionSetup(model, "api_key", undefined, {
    database: initial.database,
  });
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
  const initial = connectedSessionSetup(model, "api_key", undefined, {
    commandId: commandIds(),
  });
  expect(
    (await initial.sessions.collection(createSessionRequest())).status,
  ).toBe(201);
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
  const continued = await waitForSessionValue(
    () => recreated.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    (value) =>
      hasSessionStatus("idle")(value) &&
      JSON.stringify(value).includes("Continued after restart compaction."),
  );
  expect(JSON.stringify(continued)).toContain(
    "Restart-safe compacted handoff.",
  );
  expect(
    recreated.database
      .select({ deleted: agentSessionOperations.isDeleted })
      .from(agentSessionOperations)
      .where(eq(agentSessionOperations.sessionId, SESSION_ID))
      .get()?.deleted,
  ).toBe(true);
  closeSessionTestDatabase(initial.database);
});

test("steer_session dispatch is consumed by a running target at its boundary", async () => {
  const model = new SteeringDispatchModel();
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    commandId: commandIds(),
  });
  expect(await createPromptSession(setup, "Running steering target.")).toBe(
    SESSION_ID,
  );
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
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);

  const target = await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    (value) =>
      hasSessionStatus("idle")(value) &&
      JSON.stringify(value).includes("Steering consumed."),
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
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    commandId: commandIds(),
  });
  expect(await createPromptSession(setup, "Completed compaction target.")).toBe(
    SESSION_ID,
  );
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    hasSessionStatus("idle"),
  );
  setup.database
    .update(agentSessions)
    .set({ status: "completed" })
    .where(eq(agentSessions.id, SESSION_ID))
    .run();

  const parentId = await createPromptSession(
    setup,
    "Compact the completed target.",
  );
  await completeRunnerCommand(setup, parentId, RUNNER_AGENT_FILE_COMMAND);
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);
  expect(setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status).toBe(
    "running",
  );
  await completeRunnerCommand(setup, SESSION_ID, RUNNER_AGENT_FILE_COMMAND);

  const target = await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    (value) =>
      hasSessionStatus("idle")(value) &&
      JSON.stringify(value).includes("Completed target continued."),
  );
  const serialized = JSON.stringify(target);
  expect(serialized).toContain("Completed target handoff.");
  expect(serialized).not.toContain("Target completed before compaction.");
  closeSessionTestDatabase(setup.database);
});
