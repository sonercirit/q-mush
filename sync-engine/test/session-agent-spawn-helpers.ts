import { isRecord } from "../../shared/auth-model.ts";
import { findToolResultContent } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  toolCall,
  type startToolSession,
} from "./session-agent-tool-setup.ts";
import { completeNullRunnerCommand } from "./session-compaction-test-helpers.ts";
import {
  CREDENTIAL_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
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

export async function childSessionId(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): Promise<string> {
  const parent = await completedParentDetail(setup, "idle");
  const output = findToolResultContent(parent, "spawn_session");
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

export async function resumeCompletedParent(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  parentId: string,
): Promise<void> {
  await waitForRunnerSession(setup, parentId);
  completeChildAgentFile(setup);
}

export async function waitForChildRunnerTool(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  childId: string,
  tool?: string,
): Promise<void> {
  await waitForRunnerSession(setup, childId, tool);
}
