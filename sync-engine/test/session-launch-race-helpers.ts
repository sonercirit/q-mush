import { expect } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AppDatabase } from "../../shared/database.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../../shared/session-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import type { executeSessionAgentTool } from "../../sync-engine/session-agent-tools.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  createTestProviderCredential,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { sessionAgentActionRuntimeDefaults } from "./session-agent-action-runtime-fixtures.ts";
import { EMPTY_SESSION_REQUEST_MODEL_METADATA } from "./session-race-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

export interface SessionStoreTestSetup {
  readonly database: AppDatabase;
  readonly store: SessionStore;
}

export function closeSessionTestDatabase(database: AppDatabase): void {
  database.$client.close();
}

export function closeSessionStoreTestSetup(
  setup: Pick<SessionStoreTestSetup, "database">,
): void {
  closeSessionTestDatabase(setup.database);
}

export async function expectJsonResponse(
  response: Response,
  status: number,
  expected: unknown,
): Promise<void> {
  const body: unknown = await response.json();
  expect(response.status).toBe(status);
  expect(body).toEqual(expected);
}

export function expectStoredSession(
  setup: Pick<SessionStoreTestSetup, "store">,
  userId: string,
  sessionId: string,
  expected: object,
): AgentSessionDetail {
  const detail = setup.store.get(userId, sessionId);
  expect(detail).toMatchObject(expected);
  if (detail === undefined) {
    throw new Error(`The test session ${sessionId} is missing`);
  }
  return detail;
}

export function transitionTestSession(
  setup: SessionStoreTestSetup,
  detail: AgentSessionDetail,
  status: "failed" | "idle" | "running",
  now: () => number,
): void {
  expect(
    setup.store.transitionRuntime(detail.id, status, now(), detail.generation),
  ).toBe(true);
}

export function unsupportedFixtureStatus(status: string): never {
  throw new Error(`Unsupported fixture status: ${status}`);
}

export function expectedRestartHandoff(
  executionGeneration: number,
  operation: RestartHandoffOperation,
  restartId: string,
) {
  return {
    executionGeneration,
    operation,
    pendingInput: [],
    requestedBy: "runner" as const,
    restartId,
  };
}

export type LaunchRace = "restart" | "none" | "stale";
type LaunchCallback = (detail: AgentSessionDetail) => boolean;
interface LaunchRaceRun {
  readonly fail: LaunchCallback;
  readonly launchedSession: () => AgentSessionDetail;
  readonly runtimes: SessionRuntimes;
}
export type AgentActionsTestSetup = SessionStoreTestSetup & {
  readonly actions: ReturnType<SessionAgentActions["actions"]>;
  readonly launch: LaunchRaceRun;
  readonly parent: AgentSessionDetail;
  readonly runtimes: SessionRuntimes;
  readonly target: AgentSessionDetail | undefined;
};

export function testClock(): () => number {
  let now = TEST_NOW;
  return () => (now += 1);
}

export function expectLaunchTurnRotation(detail: AgentSessionDetail): void {
  const turns = detail.turns ?? [];
  const activeTurns = turns.filter(({ endedAt }) => endedAt === null);
  expect(activeTurns).toHaveLength(1);
  const active = activeTurns[0];
  if (active === undefined)
    throw new Error("The launched session has no active turn");
  const previous = turns.at(-2);
  if (previous !== undefined) {
    expect(previous.endedAt).not.toBeNull();
    expect(active.startedAt).toBeGreaterThan(previous.startedAt);
    expect(previous.endedAt).toBeLessThanOrEqual(active.startedAt);
  }
}

export function launchRace(
  setup: SessionStoreTestSetup,
  race: LaunchRace,
  now: () => number,
): LaunchRaceRun {
  const runtimes = new SessionRuntimes();
  const shouldDrain = race !== "none";
  let launched: AgentSessionDetail | undefined;
  return {
    fail: (detail) => {
      launched = detail;
      expectLaunchTurnRotation(detail);
      if (race === "stale") {
        transitionTestSession(setup, detail, "failed", now);
        const requeued = setup.store.queue(TEST_USER_ID, detail.id, now());
        expect(requeued.status).toBe("queued");
        if (requeued.status === "queued") {
          expectLaunchTurnRotation(requeued.detail);
        }
      }
      if (shouldDrain) {
        void runtimes.drain(
          { kind: "runner", runnerId: detail.runnerId },
          "restart-launch-race",
        );
      }
      return false;
    },
    launchedSession: () => {
      if (launched === undefined)
        throw new Error("Launch callback was not reached");
      return launched;
    },
    runtimes,
  };
}

function helperCredentialAction(credential: ProviderCredentialAccess) {
  return (
    _userId: string,
    _detail: AgentSessionDetail,
    action: (
      selected: ProviderCredentialAccess,
    ) => Promise<Response> | Response,
  ) => Promise.resolve(action(credential));
}

export function agentActionsSetup(
  race: LaunchRace,
  includeTarget: boolean,
  overrides: Partial<ConstructorParameters<typeof SessionAgentActions>[0]> = {},
): AgentActionsTestSetup {
  const setup: SessionStoreTestSetup = createStore();
  const now = testClock();
  const parent = createTestSession(setup.store);
  transitionTestSession(setup, parent, "running", now);
  const target = includeTarget ? createTestSession(setup.store) : undefined;
  if (target !== undefined) transitionTestSession(setup, target, "failed", now);
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
    discoverModels: () =>
      Promise.resolve().then(() => ({ defaultModel: null, models: [] })),
    discoverSessionMetadata: () =>
      Promise.resolve().then(() => EMPTY_SESSION_REQUEST_MODEL_METADATA),
    launchSession: (_credential, detail) => launch.fail(detail),
    listOnlineRunners: () => [],
    ...sessionAgentActionRuntimeDefaults(),
    now,
    pendingRestart: (runnerId) => launch.runtimes.pendingRestart(runnerId),
    readCredential: () => Promise.resolve(credential),
    store: setup.store,
    withCredential: helperCredentialAction(credential),
    ...overrides,
  }).actions(parent.id, TEST_USER_ID, parent.generation, DEFAULT_TOOL_SETTINGS);
  return {
    ...setup,
    actions,
    launch,
    parent,
    runtimes: launch.runtimes,
    target,
  };
}

export function spawnInput(
  setup: Pick<AgentActionsTestSetup, "parent">,
  prompt: string,
) {
  return {
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

export function spawnedSession(setup: AgentActionsTestSetup) {
  return setup.store
    .list(TEST_USER_ID)
    .find(({ id }) => id !== setup.parent.id);
}

export function parseToolOutput(
  result: Awaited<ReturnType<typeof executeSessionAgentTool>>,
): unknown {
  const value: unknown = JSON.parse(result.output);
  return value;
}
