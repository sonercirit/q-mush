import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  childSessionId,
  completeChildAgentFile,
  spawnCall,
  waitForChildRunnerTool,
} from "./session-agent-spawn-helpers.ts";
import { startToolSession, toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import {
  MultiSessionRestartModel,
  nextCommandId,
  recreateRestartSetup,
  RESTART_SESSION_COUNT,
  restartSessionIds,
  waitForRestartCommands,
} from "./session-restart-step-resume-helpers.ts";
import { completeTestRunnerCommands } from "./session-runner-command-helpers.ts";
import { waitForTerminalParentNote } from "./session-terminal-parent-helpers.ts";

const CHILD_PROMPT = "Finish this work across a server restart.";
const CHILD_TOOL_OUTPUT = "Durable child tool output.";
const CHILD_SUMMARY = "The child finished with an assistant summary.";
const COMPLETION_REPORT = "Spawned session completed:";

function includesContent(
  messages: readonly AgentConversationMessage[],
  content: string,
): boolean {
  return messages.some((message) => message.content.includes(content));
}

class RestartedSpawnModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];

  complete(
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    this.requests.push([...messages]);
    if (includesContent(messages, COMPLETION_REPORT)) {
      return Promise.resolve(
        providerStep("The parent received the true child completion."),
      );
    }
    if (includesContent(messages, CHILD_PROMPT)) {
      return Promise.resolve(
        includesContent(messages, CHILD_TOOL_OUTPUT)
          ? providerStep(CHILD_SUMMARY)
          : providerStep("The child is using a tool.", {
              toolCalls: [
                toolCall("bash", { command: "printf child", timeout: 30 }),
              ],
            }),
      );
    }
    if (
      messages.some(
        (message) =>
          message.role === "tool" && message.toolName === "spawn_session",
      )
    ) {
      return Promise.resolve(providerStep("The parent is waiting."));
    }
    return Promise.resolve(
      providerStep("The parent delegated the work.", {
        toolCalls: [spawnCall(CHILD_PROMPT, undefined, ["bash"])],
      }),
    );
  }
}

function sessionFor(
  setup: ReturnType<typeof connectedSessionSetup>,
  sessionId: string,
) {
  return setup.sessions.detailForUser(TEST_USER_ID, sessionId);
}

function completionReports(
  setup: ReturnType<typeof connectedSessionSetup>,
): readonly string[] {
  return (
    sessionFor(setup, SESSION_ID)
      ?.messages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes(COMPLETION_REPORT),
      )
      .map(({ content }) => content) ?? []
  );
}

function recreateSessionSetup(
  model: AgentModel,
  initial: ReturnType<typeof connectedSessionSetup>,
): ReturnType<typeof connectedSessionSetup> {
  return connectedSessionSetup(model, "api_key", undefined, {
    database: initial.database,
  });
}

function completeCurrentRunnerCommand(
  setup: ReturnType<typeof connectedSessionSetup>,
  output: string,
): void {
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, RUNNER_COMMAND_ID, {
      output,
      state: "completed",
    }),
  ).toBe(true);
}

test("a spawned session resumes its interrupted step after server recreation", async () => {
  const model = new RestartedSpawnModel();
  const initial = await startToolSession(model);
  const childId = await childSessionId(initial);
  completeChildAgentFile(initial);
  await waitForChildRunnerTool(initial, childId, "bash");

  const drain = initial.sessions.drain();
  completeCurrentRunnerCommand(initial, CHILD_TOOL_OUTPUT);
  await drain;

  expect(sessionFor(initial, childId)).toMatchObject({
    restartHandoff: { operation: "agent" },
    status: "paused",
  });
  expect(completionReports(initial)).toHaveLength(0);

  const recreated = recreateSessionSetup(model, initial);
  expect(completionReports(recreated)).toHaveLength(0);
  await waitForChildRunnerTool(recreated, childId);
  completeCurrentRunnerCommand(recreated, "null");
  await waitForSessionValue(
    () => sessionFor(recreated, childId),
    (value) =>
      hasSessionStatus("completed")(value) &&
      JSON.stringify(value).includes(CHILD_SUMMARY),
  );

  const resumed = model.requests.find((request) =>
    request.some(
      (message) =>
        message.role === "tool" && message.content === CHILD_TOOL_OUTPUT,
    ),
  );
  expect(
    resumed?.some(
      (message) =>
        message.role === "tool" &&
        message.content === CHILD_TOOL_OUTPUT &&
        message.toolCallId === "call-bash" &&
        message.toolName === "bash",
    ),
  ).toBe(true);
  expect(sessionFor(recreated, childId)).toMatchObject({
    restartHandoff: null,
    status: "completed",
  });
  await waitForTerminalParentNote(recreated.sessions, childId);
  expect(completionReports(recreated)).toHaveLength(1);
  expect(JSON.stringify(sessionFor(recreated, childId))).toContain(
    CHILD_SUMMARY,
  );
  expect(sessionFor(recreated, SESSION_ID)).toMatchObject({
    generation: 0,
    status: "idle",
  });
  closeSessionTestDatabase(initial.database);
});

const AGENT_FILE_COMMAND = "read_agent_file";
const CORRUPTED_HANDOFF_ERROR = "Stored restart handoff is invalid";

async function startParkedSessions(model: AgentModel) {
  const initial = connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId("restart-multi-command"),
  });
  for (let index = 0; index < RESTART_SESSION_COUNT; index += 1) {
    const created = await initial.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
  }
  return initial;
}

async function completeMultiSessionCommands(
  setup: ReturnType<typeof connectedSessionSetup>,
  tool: string,
  output: (sessionId: string) => string,
): Promise<void> {
  const commands = await waitForRestartCommands(setup, tool);
  completeTestRunnerCommands(setup, commands, (command) => ({
    output: output(command.sessionId),
    state: "completed",
  }));
}

async function drainParkedSessions(model: AgentModel): Promise<{
  readonly ids: readonly string[];
  readonly initial: ReturnType<typeof connectedSessionSetup>;
}> {
  const initial = await startParkedSessions(model);
  const ids = restartSessionIds(initial);
  await completeMultiSessionCommands(initial, AGENT_FILE_COMMAND, () => "null");
  const runningCommands = await waitForRestartCommands(initial, "bash");
  const drain = initial.sessions.drain();
  completeTestRunnerCommands(initial, runningCommands, (command) => ({
    output: `Durable tool output for ${command.sessionId}`,
    state: "completed",
  }));
  await drain;
  return { ids, initial };
}

function assertSessionStatuses(
  setup: ReturnType<typeof connectedSessionSetup>,
  ids: readonly string[],
  status: "idle" | "paused",
): void {
  const statuses = ids.map((id) => sessionFor(setup, id)?.status);
  expect(new Set(statuses)).toEqual(new Set([status]));
}

function corruptRestartHandoff(
  setup: ReturnType<typeof connectedSessionSetup>,
  sessionId: string,
): void {
  setup.database
    .update(agentSessions)
    .set({ restartHandoff: "not-json" })
    .where(eq(agentSessions.id, sessionId))
    .run();
}

test("multiple sessions resume their interrupted steps after one server recreation", async () => {
  const model = new MultiSessionRestartModel();
  const { ids, initial } = await drainParkedSessions(model);
  expect(ids).toHaveLength(RESTART_SESSION_COUNT);
  assertSessionStatuses(initial, ids, "paused");

  const recreated = recreateRestartSetup(
    model,
    initial,
    "restarted-multi-command",
  );
  recreated.sessions.runnerConnected(RUNNER_ID);
  await completeMultiSessionCommands(
    recreated,
    AGENT_FILE_COMMAND,
    () => "null",
  );
  await waitForSessionValue(
    () =>
      ids.every((id) =>
        JSON.stringify(sessionFor(recreated, id)).includes(
          "Completed after restart.",
        ),
      ),
    (value) => value === true,
  );
  assertSessionStatuses(recreated, ids, "idle");
  closeSessionTestDatabase(initial.database);
});

test("one corrupt handoff fails visibly without blocking other restart resumes", async () => {
  const model: AgentModel = new MultiSessionRestartModel();
  const parked = await drainParkedSessions(model);
  const { ids, initial } = parked;
  const corruptId = ids[1];
  if (corruptId === undefined) {
    throw new Error("The corrupt handoff fixture is unavailable");
  }
  corruptRestartHandoff(initial, corruptId);

  const recreated = recreateRestartSetup(
    model,
    initial,
    "restart-corrupt-command",
  );
  recreated.sessions.runnerConnected(RUNNER_ID);
  const commands = await waitForRestartCommands(
    recreated,
    AGENT_FILE_COMMAND,
    RESTART_SESSION_COUNT - 1,
  );
  completeTestRunnerCommands(recreated, commands, () => ({
    output: "null",
    state: "completed",
  }));
  await waitForSessionValue(
    () =>
      ids.every((id) => {
        const detail = sessionFor(recreated, id);
        return id === corruptId
          ? detail?.status === "failed"
          : detail?.status === "idle";
      }),
    (value) => value === true,
  );
  const failed = sessionFor(recreated, corruptId);
  expect(failed?.status).toBe("failed");
  expect(failed?.restartHandoff).toBeNull();
  expect(
    failed?.messages.some(
      ({ content, role }) =>
        role === "error" && content.includes(CORRUPTED_HANDOFF_ERROR),
    ),
  ).toBe(true);
  closeSessionTestDatabase(initial.database);
});
