import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { createAgentRequestRecorder } from "./assistant-prefill-test-helpers.ts";
import type {
  AgentConversationMessage,
  AgentModel,
} from "../../shared/agent-loop.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { TEST_AUTHENTICATED_USER } from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  childSessionId,
  completeChildAgentFile,
  completeWokenParent,
  spawnCall,
  waitForChildRunnerTool,
} from "./session-agent-spawn-helpers.ts";
import { startToolSession, toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
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
  completeRestartCommands,
  createMultiSessionRestartModel,
  createRestartSessions,
  expectRestartPaused,
  nextCommandId,
  recreateRestartSetup,
  RESTART_SESSION_COUNT,
  restartSessionDetail,
  restartSessionIds,
  restartSessionsInclude,
  waitForRestartCommands,
} from "./session-restart-step-resume-helpers.ts";
import { completeTestRunnerCommands } from "./session-runner-command-helpers.ts";
import { waitForTerminalParentNote } from "./session-terminal-parent-helpers.ts";

const CHILD_PROMPT = "Finish this work across a server restart.";
const CHILD_TOOL_OUTPUT = "Durable child tool output.";
const CHILD_SUMMARY = "The child finished with an assistant summary.";
const COMPACTION_REPORT_SUMMARY = "Preserve the reported child result.";
const COMPLETION_REPORT = "Spawned session completed:";

function includesContent(
  messages: readonly AgentConversationMessage[],
  content: string,
): boolean {
  return messages.some((message) => message.content.includes(content));
}

function createReportCompactionModel(): AgentModel {
  return {
    complete(messages) {
      expect(includesContent(messages, COMPLETION_REPORT)).toBe(true);
      return Promise.resolve(providerStep(COMPACTION_REPORT_SUMMARY));
    },
  };
}

interface RestartedSpawnModel extends AgentModel {
  readonly requests: AgentConversationMessage[][];
}

function createRestartedSpawnModel(): RestartedSpawnModel {
  const recorder = createAgentRequestRecorder();
  const complete: AgentModel["complete"] = (messages) => {
    recorder.record(messages);
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
  };
  return { complete, requests: recorder.requests };
}

async function startChildToolSession(model: AgentModel) {
  const setup = await startToolSession(model);
  const childId = await childSessionId(setup);
  completeChildAgentFile(setup);
  await waitForChildRunnerTool(setup, childId, "bash");
  return { childId, setup };
}

function sessionFor(
  setup: ReturnType<typeof connectedSessionSetup>,
  sessionId: string,
) {
  return restartSessionDetail(setup, sessionId);
}

async function waitForCompletedChild(
  setup: ReturnType<typeof connectedSessionSetup>,
  childId: string,
) {
  return waitForSessionValue(
    () => sessionFor(setup, childId),
    (value) =>
      hasSessionStatus("completed")(value) &&
      JSON.stringify(value).includes(CHILD_SUMMARY),
  );
}

function completionReports(
  setup: ReturnType<typeof connectedSessionSetup>,
): readonly string[] {
  const parent = sessionFor(setup, SESSION_ID);
  const combined = [
    ...(parent?.messages ?? []),
    ...(parent?.pendingInputs ?? []),
  ];
  return combined
    .filter(({ content }) => content.includes(COMPLETION_REPORT))
    .map(({ content }) => content);
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
  const model = createRestartedSpawnModel();
  const { childId, setup: initial } = await startChildToolSession(model);

  const drain = initial.sessions.drain();
  completeCurrentRunnerCommand(initial, CHILD_TOOL_OUTPUT);
  await drain;

  expectRestartPaused(initial, childId);
  expect(completionReports(initial)).toHaveLength(0);

  const recreated = recreateSessionSetup(model, initial);
  expect(completionReports(recreated)).toHaveLength(0);
  await waitForChildRunnerTool(recreated, childId);
  completeCurrentRunnerCommand(recreated, "null");
  await waitForCompletedChild(recreated, childId);

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
  await completeWokenParent(recreated);
  expect(completionReports(recreated)).toHaveLength(1);
  expect(JSON.stringify(sessionFor(recreated, childId))).toContain(
    CHILD_SUMMARY,
  );
  expect(sessionFor(recreated, SESSION_ID)).toMatchObject({
    generation: 1,
    status: "idle",
  });
  closeSessionTestDatabase(initial.database);
});

test("a reported child event survives parent compaction and is consumed on resume", async () => {
  const childModel = createRestartedSpawnModel();
  const { childId, setup: initial } = await startChildToolSession(childModel);
  completeCurrentRunnerCommand(initial, CHILD_TOOL_OUTPUT);
  await waitForCompletedChild(initial, childId);
  await waitForTerminalParentNote(initial.sessions, childId);
  await completeWokenParent(initial);
  expect(completionReports(initial)).toHaveLength(1);

  const compacted = recreateSessionSetup(
    createReportCompactionModel(),
    initial,
  );
  const response = await compacted.sessions.realtimeCommands.compactForUser(
    TEST_AUTHENTICATED_USER,
    SESSION_ID,
    sessionFor(compacted, SESSION_ID)?.workspaceId ?? "",
  );
  expect(["queued", "running"]).toContain(response.status);
  await waitForChildRunnerTool(compacted, SESSION_ID, "read_agent_file");
  const compactCommand = compacted.latestRunnerCommand();
  if (compactCommand === undefined) {
    throw new Error("The parent compaction command is unavailable");
  }
  const completed = compacted.sessions.completeRunnerCommand(
    RUNNER_ID,
    compactCommand.id,
    { output: "null", state: "completed" },
  );
  expect(completed).toBe(true);
  const compactedParent = await waitForSessionValue(
    () => sessionFor(compacted, SESSION_ID),
    hasSessionStatus("idle"),
  );
  expect(compactedParent).toMatchObject({ status: "idle" });
  expect(JSON.stringify(compactedParent)).toContain(COMPACTION_REPORT_SUMMARY);
  const afterCompaction = sessionFor(compacted, SESSION_ID);
  expect(afterCompaction?.pendingInputs).toEqual([]);
  expect(
    afterCompaction?.messages.filter(({ content }) =>
      content.includes(COMPACTION_REPORT_SUMMARY),
    ),
  ).toHaveLength(1);
  closeSessionTestDatabase(initial.database);
});

const AGENT_FILE_COMMAND = "read_agent_file";
const CORRUPTED_HANDOFF_ERROR = "Stored restart handoff is invalid";

async function startParkedSessions(model: AgentModel) {
  const initial = connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId("restart-multi-command"),
  });
  await createRestartSessions(initial, RESTART_SESSION_COUNT);
  return initial;
}

async function completeMultiSessionCommands(
  setup: ReturnType<typeof connectedSessionSetup>,
  tool: string,
  output: (sessionId: string) => string,
): Promise<void> {
  await completeRestartCommands(setup, tool, output);
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
  const model = createMultiSessionRestartModel();
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
    () => restartSessionsInclude(recreated, ids, "Completed after restart."),
    (value) => value === true,
  );
  assertSessionStatuses(recreated, ids, "idle");
  closeSessionTestDatabase(initial.database);
});

test("one corrupt handoff fails visibly without blocking other restart resumes", async () => {
  const model: AgentModel = createMultiSessionRestartModel();
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
