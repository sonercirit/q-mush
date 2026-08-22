import { isRecord } from "../../shared/auth-model.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import {
  completedParentToolResult,
  toolCall,
  type startToolSession,
} from "./session-agent-tool-setup.ts";
import { completeNullRunnerCommand } from "./session-compaction-test-helpers.ts";
import {
  CREDENTIAL_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";

export function spawnCall(
  prompt: string,
  reasoningEffort?: string,
  tools: readonly string[] = [],
  credentialId = CREDENTIAL_ID,
  agentFilePath?: string,
) {
  return toolCall("spawn_session", {
    credentialId,
    ...(agentFilePath === undefined ? {} : { agentFilePath }),
    model: "gpt-4.1-mini",
    prompt,
    provider: "openai",
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    runnerId: RUNNER_ID,
    tools,
    workingDirectory: "/work/project",
  });
}

async function waitForRunnerSession(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  sessionId: string,
  tool?: string,
): Promise<void> {
  await waitForSessionValue(
    () => setup.runnerCommands.shift(),
    (value) =>
      isRecord(value) &&
      value["sessionId"] === sessionId &&
      (tool === undefined || value["tool"] === tool),
  );
}

export async function completeWokenParent(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): Promise<void> {
  const parent = await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    (value): value is NonNullable<typeof value> =>
      typeof value === "object" &&
      value !== null &&
      "generation" in value &&
      typeof value.generation === "number" &&
      value.generation > 0 &&
      "status" in value &&
      (value.status === "idle" ||
        value.status === "failed" ||
        value.status === "running"),
  );
  if (
    !isRecord(parent) ||
    parent["status"] === "idle" ||
    parent["status"] === "failed" ||
    !isRecord(parent["runtimePending"]) ||
    parent["runtimePending"]["component"] !== "runner_command"
  ) {
    return;
  }
  await waitForRunnerSession(setup, SESSION_ID);
  const command = setup.latestRunnerCommand();
  if (command === undefined || command.sessionId !== SESSION_ID) {
    throw new Error("The woken parent command is unavailable");
  }
  const completed = setup.sessions.completeRunnerCommand(
    RUNNER_ID,
    command.id,
    {
      output: "null",
      state: "completed",
    },
  );
  if (!completed) {
    throw new Error("The woken parent command was not completed");
  }
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    (value): value is NonNullable<typeof value> =>
      typeof value === "object" &&
      value !== null &&
      "generation" in value &&
      typeof value.generation === "number" &&
      value.generation > 0 &&
      "status" in value &&
      (value.status === "idle" || value.status === "failed"),
  );
}

export async function failedSpawnOutput(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): Promise<string> {
  return (await completedParentToolResult(setup, "spawn_session")) ?? "";
}

export async function childSessionId(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): Promise<string> {
  const output = await completedParentToolResult(setup, "spawn_session");
  const parsed: unknown = JSON.parse(output ?? "null");
  if (!isRecord(parsed) || typeof parsed["sessionId"] !== "string") {
    throw new TypeError("The spawn tool did not return a session ID");
  }
  const childId = parsed["sessionId"];
  await waitForRunnerSession(setup, childId);
  return childId;
}

export function completeChildAgentFile(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): void {
  completeNullRunnerCommand(setup.sessions, RUNNER_ID, RUNNER_COMMAND_ID);
}

export async function waitForChildRunnerTool(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  childId: string,
  tool?: string,
): Promise<void> {
  await waitForRunnerSession(setup, childId, tool);
}
