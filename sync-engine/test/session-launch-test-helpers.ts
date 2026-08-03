import { expect } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import type { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionLauncher } from "../../sync-engine/session-launcher.ts";
import type { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { CREDENTIAL } from "./session-restart-orchestration-test-helpers.ts";

export function completeLaunchAgentFile(
  broker: RunnerCommandBroker,
  detail: AgentSessionDetail,
): void {
  const command = broker.take(detail.runnerId);
  expect(command?.tool).toBe(RUNNER_AGENT_FILE_COMMAND);
  if (command === undefined)
    throw new Error("The agent-file command is missing");
  expect(
    broker.complete(detail.runnerId, command.id, {
      output: "null",
      state: "completed",
    }),
  ).toBe(true);
}

export async function runLaunchedSession(options: {
  readonly broker: RunnerCommandBroker;
  readonly detail: AgentSessionDetail;
  readonly launcher: SessionLauncher;
  readonly runtimes: SessionRuntimes;
}): Promise<void> {
  expect(
    options.launcher.launch(options.detail, CREDENTIAL, TEST_USER_ID),
  ).toBe(true);
  await Promise.resolve();
  completeLaunchAgentFile(options.broker, options.detail);
  await options.runtimes.settled(options.detail.id);
}
