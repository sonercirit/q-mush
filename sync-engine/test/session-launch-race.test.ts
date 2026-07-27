import { describe, expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../../shared/session-model.ts";
import { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import { executeSessionAgentTool } from "../../sync-engine/session-agent-tools.ts";
import { startManualSessionCompaction } from "../../sync-engine/session-compaction-actions.ts";
import { createValidatedSession } from "../../sync-engine/session-creation.ts";
import type { CreateSessionInput } from "../../sync-engine/session-input.ts";
import { queueSessionForUser } from "../../sync-engine/session-queue.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import {
  createTestProviderCredential,
  TEST_AUTHENTICATED_USER,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeSessionTestDatabase,
  expectedRestartHandoff,
  expectJsonResponse,
  expectStoredSession,
  type SessionStoreTestSetup,
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

interface AgentActionsTestSetup extends SessionStoreTestSetup {
  readonly actions: ReturnType<SessionAgentActions["actions"]>;
  readonly launch: LaunchRaceRun;
  readonly parent: AgentSessionDetail;
  readonly runtimes: SessionRuntimes;
  readonly target: AgentSessionDetail | undefined;
}

interface LaunchRaceExpectation {
  readonly error: "server_restarting" | "session_launch_failed";
  readonly label: string;
  readonly race: LaunchRace;
  readonly responseStatus: 500 | 503;
}

interface ExistingLaunchPath {
  readonly label: "ordinary send" | "ordinary continue" | "manual compaction";
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

function testClock(): () => number {
  let now = TEST_NOW;
  return () => (now += 1);
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

function failCreatedSession(
  setup: SessionStoreTestSetup,
  detail: AgentSessionDetail,
  now: () => number,
): void {
  expect(
    setup.store.transitionRuntime(
      detail.id,
      "failed",
      now(),
      detail.generation,
    ),
  ).toBe(true);
}

function launchRace(
  setup: SessionStoreTestSetup,
  race: LaunchRace,
  now: () => number,
): LaunchRaceRun {
  const runtimes = new SessionRuntimes();
  let launched: AgentSessionDetail | undefined;
  const fail = (detail: AgentSessionDetail): boolean => {
    launched = detail;
    if (race === "stale") {
      failCreatedSession(setup, detail, now);
      const requeued = setup.store.queue(TEST_USER_ID, detail.id, now());
      expect(requeued.status).toBe("queued");
    }
    if (race !== "none") {
      void runtimes.drain(
        { kind: "runner", runnerId: detail.runnerId },
        RESTART_ID,
      );
    }
    return false;
  };
  const launchedSession = (): AgentSessionDetail => {
    if (launched === undefined) {
      throw new Error("The production launch callback was not reached");
    }
    return launched;
  };
  return { fail, launchedSession, runtimes };
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

  expect(restart).toEqual({ requestedBy: "runner", restartId: RESTART_ID });
  const nextGeneration = launched.generation + 1;
  return expectStoredSession(setup, TEST_USER_ID, launched.id, {
    generation: nextGeneration,
    restartHandoff:
      race === "restart"
        ? expectedRestartHandoff(nextGeneration, operation, RESTART_ID)
        : null,
    status: race === "restart" ? "paused" : "queued",
  });
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

function failedSessionSetup(): FailedLaunchTestSetup {
  const setup = createStore();
  const now = testClock();
  const detail = createTestSession(setup.store);
  failCreatedSession(setup, detail, now);
  return {
    ...setup,
    credential: createTestProviderCredential(detail.credentialId),
    detail,
    now,
  };
}

function failedLaunchRaceSetup(race: LaunchRace): FailedLaunchRaceSetup {
  const setup = failedSessionSetup();
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

function agentActionsSetup(
  race: LaunchRace,
  includeTarget: boolean,
): AgentActionsTestSetup {
  const setup = createStore();
  const now = testClock();
  const parent = createTestSession(setup.store);
  expect(
    setup.store.transitionRuntime(
      parent.id,
      "running",
      now(),
      parent.generation,
    ),
  ).toBe(true);
  const target = includeTarget ? createTestSession(setup.store) : undefined;
  if (target !== undefined) {
    failCreatedSession(setup, target, now);
  }
  const credential = createTestProviderCredential(parent.credentialId);
  const launch = launchRace(setup, race, now);
  const actions = new SessionAgentActions({
    abortSession: () => undefined,
    activeSession: () => false,
    broker: new RunnerCommandBroker(),
    browseDirectories: () =>
      Promise.resolve({ status: "directory_unavailable" }),
    cleanupSession: () => undefined,
    database: setup.database,
    discoverModels: testModelCatalog,
    discoverSessionMetadata: () =>
      Promise.resolve().then(() => ({
        maxContextTokens: null,
        providerPricing: null,
      })),
    draining: () => false,
    launchSession: (_credential, detail) => launch.fail(detail),
    listOnlineRunners: () => [],
    listRunnerOptions: () => ({ items: [], totalItems: 0 }),
    notify: () => undefined,
    now,
    pendingRestart: (runnerId) => launch.runtimes.pendingRestart(runnerId),
    readCredential: () => Promise.resolve(credential),
    runnerIsAvailable: () => true,
    store: setup.store,
    withCredential: credentialAction(credential),
  }).actions(
    parent.id,
    TEST_USER_ID,
    parent.generation,
    new AbortController().signal,
  );
  return {
    ...setup,
    actions,
    launch,
    parent,
    runtimes: launch.runtimes,
    target,
  };
}

function spawnInput(
  setup: Pick<AgentActionsTestSetup, "parent">,
  prompt: string,
  autoCompact?: unknown,
) {
  return {
    ...(autoCompact === undefined ? {} : { autoCompact }),
    credentialId: setup.parent.credentialId,
    executionEnvironment: setup.parent.executionEnvironment,
    model: setup.parent.model,
    prompt,
    provider: setup.parent.provider,
    runnerId: setup.parent.runnerId,
    tools: AGENT_SESSION_TOOL_NAMES,
    workingDirectory: setup.parent.workingDirectory,
  };
}

function spawnedSessionAutoCompact(
  setup: AgentActionsTestSetup,
): boolean | undefined {
  return setup.store.list(TEST_USER_ID).find(({ id }) => id !== setup.parent.id)
    ?.autoCompact;
}

function parseToolOutput(
  result: Awaited<ReturnType<typeof executeSessionAgentTool>>,
): unknown {
  const value: unknown = JSON.parse(result.output);
  return value;
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

const EXISTING_LAUNCH_PATHS: readonly ExistingLaunchPath[] = [
  {
    label: "ordinary send",
    operation: "agent",
    run: (setup) =>
      queueLaunchCase(setup, { images: [], prompt: "Queued follow-up" }),
  },
  {
    label: "ordinary continue",
    operation: "agent",
    run: (setup) => queueLaunchCase(setup),
  },
  {
    label: "manual compaction",
    operation: "compact",
    run: (setup) =>
      startManualSessionCompaction(
        {
          ...launchBoundary(setup),
          credential: credentialAction(setup.credential),
        },
        TEST_AUTHENTICATED_USER,
        setup.detail.id,
      ),
  },
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
        runtimes: launch.runtimes,
        store: setup.store,
      },
      TEST_AUTHENTICATED_USER,
      sessionInput(inputSource),
      credential,
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
      const setup = failedLaunchRaceSetup(expected.race);
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
    );

    expect(parseToolOutput(output)).toEqual({ error: expected.error });
    assertLaunchResponse(setup, setup.launch, expected, "agent");
  });
}

test("validates and persists spawn auto-compaction", async () => {
  for (const autoCompact of ["false", 0, null]) {
    const setup = agentActionsSetup("none", false);
    const invalidSpawn = spawnInput(
      setup,
      "Do not create this child",
      autoCompact,
    );
    const output = await executeSessionAgentTool(
      setup.actions,
      "spawn_session",
      invalidSpawn,
    );

    expect(output).toEqual({
      output: "Error: The spawn_session arguments are invalid",
      state: "failed",
    });
    expect(setup.store.list(TEST_USER_ID)).toHaveLength(1);
    closeSessionTestDatabase(setup.database);
  }

  const setup = agentActionsSetup("none", false);

  await executeSessionAgentTool(
    setup.actions,
    "spawn_session",
    spawnInput(setup, "Create with the default"),
  );
  expect(spawnedSessionAutoCompact(setup)).toBe(true);
  closeSessionTestDatabase(setup.database);

  const disabledSetup = agentActionsSetup("none", false);
  await executeSessionAgentTool(
    disabledSetup.actions,
    "spawn_session",
    spawnInput(disabledSetup, "Create without automatic compaction", false),
  );
  expect(spawnedSessionAutoCompact(disabledSetup)).toBe(false);
  closeSessionTestDatabase(disabledSetup.database);
});

describe.each(LAUNCH_RACES)("$label", (expected) => {
  launchRaceTests(expected);
});
