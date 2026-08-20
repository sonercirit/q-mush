import { describe, expect, test, vi } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  RestartHandoffOperation,
} from "../../shared/session-model.ts";
import { executeSessionAgentTool } from "../../sync-engine/session-agent-tools.ts";
import { startManualSessionCompaction } from "../../sync-engine/session-compaction-actions.ts";
import { createValidatedSession } from "../../sync-engine/session-creation.ts";
import type { CreateSessionInput } from "../../sync-engine/session-input.ts";
import { queueSessionForUser } from "../../sync-engine/session-queue.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import {
  createTestProviderCredential,
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  agentActionsSetup,
  closeSessionTestDatabase,
  expectedRestartHandoff,
  expectJsonResponse,
  expectLaunchTurnRotation,
  expectStoredSession,
  launchRace,
  parseToolOutput,
  type SessionStoreTestSetup,
  spawnedSession,
  spawnInput,
  testClock,
  transitionTestSession,
  unsupportedFixtureStatus,
} from "./session-launch-race-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";
const RESTART_ID = "restart-launch-race";
type LaunchRace = "restart" | "none" | "stale";
interface LaunchRaceRun {
  readonly fail: (detail: AgentSessionDetail) => boolean;
  readonly launchedSession: () => AgentSessionDetail;
  readonly runtimes: SessionRuntimes;
}
interface FailedLaunchTestSetup extends SessionStoreTestSetup {
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly now: () => number;
}

interface FailedLaunchRaceSetup extends FailedLaunchTestSetup {
  readonly launch: LaunchRaceRun;
  readonly runtimes: SessionRuntimes;
}

interface LaunchRaceExpectation {
  readonly error: "server_restarting" | "session_launch_failed";
  readonly label: string;
  readonly race: LaunchRace;
  readonly responseStatus: 500 | 503;
}

interface ExistingLaunchPath {
  readonly initialStatus: "failed" | "idle";
  readonly label:
    | "ordinary send"
    | "ordinary continue"
    | "manual compaction"
    | "manual compact and continue";
  readonly operation: RestartHandoffOperation;
  readonly run: (setup: FailedLaunchRaceSetup) => Promise<Response>;
}

const LAUNCH_RACES: readonly LaunchRaceExpectation[] = [
  {
    error: "server_restarting",
    label: "an exact pending restart",
    race: "restart",
    responseStatus: 503,
  },
  {
    error: "session_launch_failed",
    label: "no matching restart",
    race: "none",
    responseStatus: 500,
  },
  {
    error: "session_launch_failed",
    label: "a stale queued generation",
    race: "stale",
    responseStatus: 500,
  },
];

function testModelCatalog() {
  return Promise.resolve().then(() => ({ defaultModel: null, models: [] }));
}

function sessionInput(
  detail: AgentSessionDetail,
  prompt = "Exercise the launch boundary",
): CreateSessionInput & { readonly workspaceId: string } {
  return {
    autoCompact: true,
    credentialId: detail.credentialId,
    executionEnvironment: detail.executionEnvironment,
    images: [],
    model: detail.model,
    openRouterProviderTag: detail.openRouterProviderTag,
    prompt,
    provider: detail.provider,
    reasoningEffort: detail.reasoningEffort,
    runnerId: detail.runnerId,
    tools: AGENT_SESSION_TOOL_NAMES,
    workingDirectory: detail.workingDirectory,
    workspaceId: detail.workspaceId,
  };
}

function assertLaunchRaceState(
  setup: SessionStoreTestSetup,
  launch: LaunchRaceRun,
  race: LaunchRace,
  operation: RestartHandoffOperation,
  noRestartStatus: "failed" | "queued" = "failed",
): AgentSessionDetail {
  const launched = launch.launchedSession();
  const restart = launch.runtimes.pendingRestart(launched.runnerId);
  if (race === "none") {
    expect(restart).toBeUndefined();
    return expectStoredSession(setup, TEST_USER_ID, launched.id, {
      generation: launched.generation,
      restartHandoff: null,
      status: noRestartStatus,
    });
  }

  expect(restart).toMatchObject({
    requestedBy: "runner",
  });
  const nextGeneration = launched.generation + 1;
  const authoritative = expectStoredSession(setup, TEST_USER_ID, launched.id, {
    generation: nextGeneration,
    restartHandoff:
      race === "restart"
        ? expectedRestartHandoff(nextGeneration, operation, RESTART_ID)
        : null,
    status: race === "restart" ? "paused" : "queued",
  });
  expectLaunchTurnRotation(authoritative);
  return authoritative;
}

function assertLaunchResponse(
  setup: SessionStoreTestSetup,
  launch: LaunchRaceRun,
  expected: LaunchRaceExpectation,
  operation: RestartHandoffOperation,
  noRestartStatus: "failed" | "queued" = "failed",
): AgentSessionDetail {
  const detail = assertLaunchRaceState(
    setup,
    launch,
    expected.race,
    operation,
    noRestartStatus,
  );
  closeSessionTestDatabase(setup.database);
  return detail;
}

async function expectLaunchResponse(
  response: Response,
  expected: LaunchRaceExpectation,
): Promise<void> {
  await expectJsonResponse(response, expected.responseStatus, {
    error: expected.error,
  });
}

function credentialAction(
  credential: ProviderCredentialAccess,
): (
  userId: string,
  detail: AgentSessionDetail,
  action: (selected: ProviderCredentialAccess) => Promise<Response> | Response,
) => Promise<Response> {
  return (_userId, _detail, action) => Promise.resolve(action(credential));
}

function failCreatedSession(
  setup: SessionStoreTestSetup,
  detail: AgentSessionDetail,
  now: () => number,
): void {
  transitionTestSession(setup, detail, "failed", now);
}

function launchableSessionSetup(
  status: AgentSessionStatus,
): FailedLaunchTestSetup {
  const setup = createStore();
  const now = testClock();
  const created = createTestSession(setup.store);
  switch (status) {
    case "completed": {
      return unsupportedFixtureStatus(status);
    }
    case "failed":
      failCreatedSession(setup, created, now);
      break;
    case "idle":
      transitionTestSession(setup, created, "running", now);
      transitionTestSession(setup, created, "idle", now);
      break;
    case "paused":
      expect(
        setup.store.pauseQueuedForRestart(
          { generation: created.generation, sessionId: created.id },
          "server",
          RESTART_ID,
          "compact",
          now(),
        ),
      ).toBe(true);
      break;
    case "queued":
      break;
    case "running":
      transitionTestSession(setup, created, "running", now);
      break;
    case "stopped":
      expect(setup.store.stop(TEST_USER_ID, created.id, now())).toBe(true);
      break;
  }
  const detail = expectStoredSession(setup, TEST_USER_ID, created.id, {
    status,
  });
  return {
    ...setup,
    credential: createTestProviderCredential(detail.credentialId),
    detail,
    now,
  };
}

function failedLaunchRaceSetup(
  race: LaunchRace,
  status: "failed" | "idle" = "failed",
): FailedLaunchRaceSetup {
  const setup = launchableSessionSetup(status);
  const launch = launchRace(setup, race, setup.now);
  return { ...setup, launch, runtimes: launch.runtimes };
}

function launchBoundary(setup: FailedLaunchRaceSetup) {
  return {
    launch: (detail: AgentSessionDetail) => setup.launch.fail(detail),
    notify: () => undefined,
    now: setup.now,
    runtimes: setup.runtimes,
    store: setup.store,
  };
}

function queueLaunchCase(
  setup: FailedLaunchRaceSetup,
  prompt?: { readonly images: readonly []; readonly prompt: string },
): Promise<Response> {
  return queueSessionForUser(
    {
      ...launchBoundary(setup),
      credential: credentialAction(setup.credential),
      runnerIsAvailable: () => true,
    },
    TEST_USER_ID,
    setup.detail.id,
    prompt,
  );
}

function manualCompactionLaunchPath(
  initialStatus: "failed" | "idle",
  operation: Extract<
    RestartHandoffOperation,
    "compact" | "compact_and_continue"
  >,
): ExistingLaunchPath {
  return {
    initialStatus,
    label:
      operation === "compact"
        ? "manual compaction"
        : "manual compact and continue",
    operation,
    run: (setup) =>
      startManualSessionCompaction(
        {
          ...launchBoundary(setup),
          credential: credentialAction(setup.credential),
          operation,
        },
        TEST_AUTHENTICATED_USER,
        setup.detail.id,
      ),
  };
}

const EXISTING_LAUNCH_PATHS: readonly ExistingLaunchPath[] = [
  {
    initialStatus: "failed",
    label: "ordinary send",
    operation: "agent",
    run: (setup) =>
      queueLaunchCase(setup, { images: [], prompt: "Queued follow-up" }),
  },
  {
    initialStatus: "failed",
    label: "ordinary continue",
    operation: "agent",
    run: (setup) => queueLaunchCase(setup),
  },
  manualCompactionLaunchPath("failed", "compact"),
  manualCompactionLaunchPath("idle", "compact_and_continue"),
];

function launchRaceTests(expected: LaunchRaceExpectation): void {
  test(`create handles ${expected.label} at its launch call`, async () => {
    const setup = createStore();
    const now = testClock();
    const inputSource = createTestSession(setup.store);
    const credential = createTestProviderCredential(inputSource.credentialId);
    const launch = launchRace(setup, expected.race, now);

    const response = await createValidatedSession(
      {
        discoverModels: () => testModelCatalog(),
        discoverOpenRouterProviders: () =>
          Promise.resolve({
            providers: [],
            stale: false,
          }),
        launch: (detail) => launch.fail(detail),
        notify: () => undefined,
        now,
        restartSignal: () => new AbortController().signal,
        runtimes: launch.runtimes,
        store: setup.store,
      },
      TEST_AUTHENTICATED_USER,
      sessionInput(inputSource),
      credential,
      new AbortController().signal,
    );

    const authoritative = assertLaunchRaceState(
      setup,
      launch,
      expected.race,
      "agent",
    );
    await expectJsonResponse(response, 201, authoritative);
    closeSessionTestDatabase(setup.database);
  });

  for (const path of EXISTING_LAUNCH_PATHS) {
    test(`${path.label} handles ${expected.label} at its launch call`, async () => {
      const setup = failedLaunchRaceSetup(expected.race, path.initialStatus);
      const response = await path.run(setup);

      await expectLaunchResponse(response, expected);
      assertLaunchResponse(setup, setup.launch, expected, path.operation);
    });
  }

  test(`child spawn handles ${expected.label} at its launch call`, async () => {
    const setup = agentActionsSetup(expected.race, false);
    const output = await executeSessionAgentTool(
      setup.actions,
      "spawn_session",
      spawnInput(setup, "Delegate through the production spawn path"),
      new AbortController().signal,
    );

    if (expected.race === "restart") {
      expect(parseToolOutput(output)).toEqual({ error: expected.error });
    } else {
      expect(output).toEqual({
        output: "Error: The agent session was stopped",
        state: "failed",
      });
    }
    const child = assertLaunchRaceState(
      setup,
      setup.launch,
      expected.race,
      "agent",
      "queued",
    );
    if (expected.race === "none") {
      expect(child.messages).toEqual([
        expect.objectContaining({
          content: "Delegate through the production spawn path",
          role: "user",
        }),
      ]);
    }
    closeSessionTestDatabase(setup.database);
  });

  test(`agent-tool queue handles ${expected.label} at its launch call`, async () => {
    const setup = agentActionsSetup(expected.race, true);
    if (setup.target === undefined) {
      throw new Error("The agent-tool queue target is missing");
    }

    const output = await executeSessionAgentTool(
      setup.actions,
      "continue_session",
      { sessionId: setup.target.id },
      new AbortController().signal,
    );

    expect(parseToolOutput(output)).toEqual({ error: expected.error });
    assertLaunchResponse(setup, setup.launch, expected, "agent");
  });
}

test("persists unrestricted paths", async () => {
  const scenarios = [
    {
      agentFilePath: "config/rules.md",
      workingDirectory: "/other/work",
    },
    { agentFilePath: "/x/rules.md" },
  ] as const;
  for (const scenario of scenarios) {
    await spawnAndInspect(scenario, (spawned) => {
      expect(spawned).toMatchObject(scenario);
    });
  }
});

async function spawnAndInspect(
  input: Record<string, unknown>,
  inspect: (spawned: ReturnType<typeof spawnedSession>) => void,
): Promise<void> {
  const setup = agentActionsSetup("none", false);
  await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    { ...spawnInput(setup, "Create the child"), ...input },
    new AbortController().signal,
  );
  inspect(spawnedSession(setup));
  closeSessionTestDatabase(setup.database);
}

async function expectSpawnedFlag(
  input: Record<string, unknown>,
  flag: "autoCompact" | "idleCompact",
  expected: boolean,
): Promise<void> {
  await spawnAndInspect(input, (spawned) => {
    expect(spawned?.[flag]).toBe(expected);
  });
}

test.each([
  ["autoCompact", true, false] as const,
  ["idleCompact", false, true] as const,
])(
  "validates and persists spawn %s",
  async (flag, defaultValue, explicitValue) => {
    for (const invalid of ["false", 0, null]) {
      const setup = agentActionsSetup("none", false);
      const output = await executeSessionAgentTool(
        setup.actions,
        "spawn_session",
        { ...spawnInput(setup, "Do not create this child"), [flag]: invalid },
        new AbortController().signal,
      );

      expect(output).toEqual({
        output: "Error: The spawn_session arguments are invalid",
        state: "failed",
      });
      expect(setup.store.list(TEST_USER_ID)).toHaveLength(1);
      closeSessionTestDatabase(setup.database);
    }

    await expectSpawnedFlag({}, flag, defaultValue);
    await expectSpawnedFlag({ [flag]: explicitValue }, flag, explicitValue);
  },
);

test.each(["failed", "paused", "queued", "running", "stopped"] as const)(
  "rejects compact and continue for a $status session before credential access",
  async (status) => {
    const setup = launchableSessionSetup(status);
    const credential = vi.fn(credentialAction(setup.credential));

    const response = await startManualSessionCompaction(
      {
        credential,
        launch: () => true,
        notify: () => undefined,
        now: setup.now,
        operation: "compact_and_continue",
        runtimes: new SessionRuntimes(),
        store: setup.store,
      },
      TEST_AUTHENTICATED_USER,
      setup.detail.id,
    );

    await expectJsonResponse(response, 409, { error: "session_busy" });
    expect(credential).not.toHaveBeenCalled();
    expectStoredSession(setup, TEST_USER_ID, setup.detail.id, { status });
    closeSessionTestDatabase(setup.database);
  },
);

describe.each(LAUNCH_RACES)("$label", (expected) => {
  launchRaceTests(expected);
});
