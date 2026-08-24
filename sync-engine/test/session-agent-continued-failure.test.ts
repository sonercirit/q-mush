import { expect, test, vi } from "vitest";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { createSessionAgentActions } from "../session-agent-actions.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  spawnedParentReports,
  terminalEventActionSetup,
} from "./session-race-test-helpers.ts";
import {
  closeSpawnedChildSetup,
  expectNoPendingSpawnedSessions,
  spawnedChildSetup,
  spawnedSessionsExcluding,
} from "./session-store-spawn-test-helpers.ts";

function failedReport(setup: ReturnType<typeof spawnedChildSetup>): string {
  const reports = spawnedParentReports(setup.store, setup.parentId).filter(
    (content) => content.includes("Spawned session failed"),
  );
  expect(reports).toHaveLength(1);
  const report = reports[0];
  if (report === undefined)
    throw new Error("The failure report is unavailable");
  return report;
}

function expectLaunchFailureReport(
  setup: ReturnType<typeof spawnedChildSetup>,
  notify: ReturnType<typeof vi.fn>,
  generation: number,
): void {
  const report = failedReport(setup);
  expect(report).toContain(
    "Session failed: the child session could not be launched",
  );
  expect(report).toContain(`"generation": ${String(generation)}`);
  expect(notify).toHaveBeenCalledWith(TEST_USER_ID, setup.parentId);
}

function actionsForFailedLaunch(setup: ReturnType<typeof spawnedChildSetup>) {
  const notify = vi.fn();
  const dependencies = terminalEventActionSetup(setup, () => false, notify);
  const actions = createSessionAgentActions({
    ...dependencies,
    now: () => TEST_NOW + 6,
  }).actions(
    setup.parentId,
    TEST_USER_ID,
    setup.parentGeneration,
    DEFAULT_TOOL_SETTINGS,
  );
  return { actions, notify };
}

test("immediate spawn launch failure reports the created child before returning", async () => {
  const setup = spawnedChildSetup();
  const originalChildId = setup.childId;
  const { actions, notify } = actionsForFailedLaunch(setup);
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  if (parent === undefined) throw new Error("The parent is unavailable");

  await expect(
    actions.spawnSession(
      {
        agentFilePath: null,
        autoCompact: true,
        credentialId: parent.credentialId,
        idleCompact: false,
        executionEnvironment: parent.executionEnvironment,
        images: [],
        model: parent.model,
        openRouterProviderTag: null,
        prompt: "Fail immediately after creation",
        provider: parent.provider,
        reasoningEffort: null,
        runnerId: parent.runnerId,
        tools: [],
        workingDirectory: parent.workingDirectory,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("could not be launched");
  const [child] = spawnedSessionsExcluding(setup.store, [
    setup.parentId,
    originalChildId,
  ]);
  expect(child).toMatchObject({ status: "failed" });
  expectLaunchFailureReport(setup, notify, 0);
  closeSpawnedChildSetup(setup);
});

test("failed continued generations are reported synchronously when launch fails", async () => {
  const setup = spawnedChildSetup();
  const firstGeneration = setup.childGeneration;
  const { actions, notify } = actionsForFailedLaunch(setup);

  await expect(
    actions.continueSession(setup.childId, new AbortController().signal),
  ).resolves.toContain("session_launch_failed");
  expect(setup.store.get(TEST_USER_ID, setup.childId)).toMatchObject({
    generation: firstGeneration + 1,
    status: "failed",
  });
  expectLaunchFailureReport(setup, notify, firstGeneration + 1);
  expectNoPendingSpawnedSessions(setup);
  closeSpawnedChildSetup(setup);
});
