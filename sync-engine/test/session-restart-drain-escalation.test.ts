import { expect, test } from "vitest";
import {
  connectedSessionSetup,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import { waitForRestartDrainCount } from "./session-restart-progress-test-helpers.ts";
import {
  completeRestartCommands,
  createRestartSessions,
  createMultiSessionRestartModel,
  nextCommandId,
  recreateRestartSetup,
  RESTART_SESSION_COUNT,
  restartSessionDetail,
  restartSessionsInclude,
  restartSessionStatuses,
  waitForRestartCommands,
  type RestartStepSetup,
} from "./session-restart-step-resume-helpers.ts";

const AGENT_FILE_COMMAND = "read_agent_file";
const COMPLETED_AFTER_RESTART = "Completed after restart.";
const INTERRUPTED_TOOL_OUTPUT = "interrupted by a restart after dispatch";

async function startBusySessions(): Promise<{
  readonly ids: readonly string[];
  readonly setup: RestartStepSetup;
}> {
  const setup = connectedSessionSetup(
    createMultiSessionRestartModel(),
    "api_key",
    undefined,
    { commandId: nextCommandId("escalation-command") },
  );
  const ids = await createRestartSessions(setup, RESTART_SESSION_COUNT);
  await completeRestartCommands(setup, AGENT_FILE_COMMAND, () => "null");
  // Leaves every session inside a runner tool call that never returns.
  await waitForRestartCommands(setup, "bash");
  return { ids, setup };
}

test("a second restart request force-parks sessions stuck in long tool calls", async () => {
  const { ids, setup } = await startBusySessions();

  const first = setup.sessions.drain();
  await waitForRestartDrainCount(setup.sessions, RESTART_SESSION_COUNT);
  expect(
    setup.sessions
      .drainProgress()
      .every(
        (progress) =>
          progress.runnerId === RUNNER_ID &&
          ids.includes(progress.sessionId) &&
          progress.tools.some(({ name }) => name === "bash"),
      ),
  ).toBe(true);

  const second = setup.sessions.drain();
  await second;
  await first;

  expect(setup.sessions.drainProgress()).toEqual([]);
  expect(restartSessionStatuses(setup, ids)).not.toContain("stopped");

  const recreated = recreateRestartSetup(
    createMultiSessionRestartModel(),
    setup,
    "escalated-command",
  );
  recreated.sessions.runnerConnected(RUNNER_ID);
  expect(restartSessionStatuses(recreated, ids)).toEqual(new Set(["paused"]));
  await completeRestartCommands(recreated, AGENT_FILE_COMMAND, () => "null");
  await completeRestartCommands(
    recreated,
    "bash",
    (sessionId) => `Durable tool output for ${sessionId}`,
  );
  await waitForSessionValue(
    () => restartSessionsInclude(recreated, ids, COMPLETED_AFTER_RESTART),
    (value) => value === true,
  );

  expect(restartSessionStatuses(recreated, ids)).toEqual(new Set(["idle"]));
  for (const id of ids) {
    expect(JSON.stringify(restartSessionDetail(recreated, id))).toContain(
      INTERRUPTED_TOOL_OUTPUT,
    );
  }
  closeSessionTestDatabase(setup.database);
});
