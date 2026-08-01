import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
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
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

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
      hasSessionStatus("idle")(value) &&
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
    status: "idle",
  });
  const reports = await waitForSessionValue(
    () => completionReports(recreated),
    (value) => Array.isArray(value) && value.length === 1,
  );
  expect(reports).toHaveLength(1);
  if (!Array.isArray(reports) || typeof reports[0] !== "string") {
    throw new Error("The child completion report is unavailable");
  }
  expect(reports[0]).toContain(CHILD_SUMMARY);
  expect(reports[0]).toContain('"role": "assistant"');
  expect(reports[0]).not.toContain('"role": "tool"');
  closeSessionTestDatabase(initial.database);
});
