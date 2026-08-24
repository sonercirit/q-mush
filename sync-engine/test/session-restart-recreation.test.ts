import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { createCredentialCipher } from "../../shared/credential-cipher.ts";
import {
  agentSessions,
  providerCredentials,
} from "../../shared/database/schema.ts";
import {
  createProviderCredentialStore,
} from "../../shared/provider-credential-store.ts";
import {
  createSessionRestartControl,
  type SessionRestartControl,
} from "../../sync-engine/session-restart-control.ts";
import { SessionRestartCoordinator } from "../../sync-engine/session-restart-coordinator.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeCompactionStore,
  requireCompactionSession,
} from "./session-compaction-test-helpers.ts";
import {
  expectRestartState,
  pausedRunnerRestartStore,
  restartTestCredential,
  settleRestartRecovery,
} from "./session-restart-cpd-helpers.ts";
import { STORE_RUNNER_ID } from "./session-store-test-fixtures.ts";

type RestartCoordinatorLaunch = ConstructorParameters<
  typeof SessionRestartCoordinator
>[0]["launch"];
type RestartCoordinatorCredentialRead = ConstructorParameters<
  typeof SessionRestartCoordinator
>[0]["providers"]["openai"]["readCredential"];

interface RestartCoordinatorFixture {
  readonly coordinator: SessionRestartCoordinator;
  readonly restart: SessionRestartControl;
  readonly retryDelays: number[];
  readonly runRetry: () => void;
}

function restartCoordinatorFixture(
  setup: ReturnType<typeof pausedRunnerRestartStore>["setup"],
  launch: RestartCoordinatorLaunch,
  now: number,
  readCredential: RestartCoordinatorCredentialRead = () => CREDENTIAL,
): RestartCoordinatorFixture {
  const restart = createSessionRestartControl(
    new SessionRuntimes(),
    () => "unused-server-restart",
  );
  let retry: (() => void) | undefined;
  const retryDelays: number[] = [];
  const coordinator = new SessionRestartCoordinator(
    {
      launch,
      notify: () => undefined,
      now: () => now,
      providers: {
        openai: { readCredential },
        openrouter: { readCredential: () => undefined },
      },
      recoverInterrupted: () => undefined,
      restart,
      runnerIsAvailable: () => true,
      store: setup.store,
    },
    {
      clearTimeout: () => undefined,
      setTimeout: (callback, delay) => {
        retry = callback;
        retryDelays.push(delay);
        return retryDelays.length;
      },
    },
  );
  return {
    coordinator,
    restart,
    retryDelays,
    runRetry: () => {
      const callback = retry;
      retry = undefined;
      callback?.();
    },
  };
}

function expectRunnerAcceptance(
  fixture: RestartCoordinatorFixture,
  expected: boolean,
): void {
  expect(fixture.restart.accepts(STORE_RUNNER_ID)).toBe(expected);
}

function expectLaunches(
  launches: readonly string[],
  expected: readonly string[],
): void {
  expect(launches).toEqual(expected);
}

function restoredCoordinator(
  fixture: RestartCoordinatorFixture,
  expected: ReturnType<SessionRestartCoordinator["pendingRunnerRestart"]>,
): SessionRestartCoordinator {
  fixture.coordinator.restoreDurableRunnerGates();
  expectRunnerAcceptance(fixture, false);
  expect(fixture.coordinator.pendingRunnerRestart(STORE_RUNNER_ID)).toEqual(
    expected,
  );
  return fixture.coordinator;
}

async function recoverRunner(
  coordinator: SessionRestartCoordinator,
  restartId?: string,
): Promise<void> {
  coordinator.recover(STORE_RUNNER_ID, restartId);
  await settleRestartRecovery({ steps: 3 });
}

const CREDENTIAL = restartTestCredential("restart-recreation-credential", {
  accountId: "restart-recreation-account",
  label: "Restart recreation key",
  secret: "restart-recreation-secret",
});

test("recreated runtimes recover a durable runner handoff only through its exact restart ID", async () => {
  const { identity, setup } = pausedRunnerRestartStore(
    "restart-after-recreation",
  );
  const running = requireCompactionSession(setup.store);

  const attempts: string[] = [];
  const firstRecovery = Promise.withResolvers<undefined>();
  const fixture = restartCoordinatorFixture(
    setup,
    (detail, _credential, userId, operation) => {
      attempts.push(`${userId}:${detail.id}:${operation}`);
      return true;
    },
    TEST_NOW + 3,
    () => firstRecovery.promise.then(() => CREDENTIAL),
  );

  const coordinator = restoredCoordinator(fixture, {
    requestedBy: "runner",
    restartId: "restart-after-recreation",
    status: "pending",
  });
  fixture.coordinator.restoreDurableRunnerGates();
  for (const restartId of [undefined, "restart-mismatch"] as const) {
    await recoverRunner(coordinator, restartId);
    expectLaunches(attempts, []);
    expectRunnerAcceptance(fixture, false);
    expectRestartState(
      requireCompactionSession(setup.store),
      identity,
      "paused",
    );
  }
  expect(coordinator.resumeRunner(STORE_RUNNER_ID, "restart-mismatch")).toBe(
    false,
  );
  expectRunnerAcceptance(fixture, false);

  const expectedLaunches = [`${TEST_USER_ID}:${running.id}:agent`];
  coordinator.recover(STORE_RUNNER_ID);
  coordinator.recover(STORE_RUNNER_ID, "restart-after-recreation");
  firstRecovery.resolve(undefined);
  await settleRestartRecovery({ steps: 5 });
  expectLaunches(attempts, expectedLaunches);
  expectRunnerAcceptance(fixture, true);

  expectRestartState(requireCompactionSession(setup.store), identity, "queued");

  await recoverRunner(coordinator, "restart-after-recreation");
  expectLaunches(attempts, expectedLaunches);
  expectRestartState(requireCompactionSession(setup.store), identity, "queued");
  closeCompactionStore(setup);
});

test("restart recovery enforces the pending session workspace credential scope", async () => {
  const { identity, setup } = pausedRunnerRestartStore("restart-scope");
  const running = requireCompactionSession(setup.store);
  const cipher = createCredentialCipher(
    Buffer.from(Uint8Array.from({ length: 32 }, () => 0)).toString("base64url"),
    "Credential encryption key",
    (size) => new Uint8Array(size),
  );
  setup.database
    .update(providerCredentials)
    .set({
      encryptedCredential: cipher.seal(
        CREDENTIAL.secret,
        `${TEST_USER_ID}:${running.credentialId}`,
      ),
      isGlobal: false,
    })
    .where(eq(providerCredentials.id, running.credentialId))
    .run();
  const credentialStore = createProviderCredentialStore(
    setup.database,
    cipher,
    "openai",
  );
  expect(
    credentialStore.read(TEST_USER_ID, running.credentialId),
  ).toBeDefined();
  expect(
    credentialStore.read(
      TEST_USER_ID,
      running.credentialId,
      running.workspaceId,
    ),
  ).toBeUndefined();
  const reads: {
    readonly credentialId: string;
    readonly userId: string;
    readonly workspaceId: string | undefined;
  }[] = [];
  const scopeLaunches = new Set<string>();
  const fixture = restartCoordinatorFixture(
    setup,
    (detail) => (scopeLaunches.add(detail.id), true),
    TEST_NOW + 3,
    (userId, credentialId, workspaceId) => {
      reads.push({ credentialId, userId, workspaceId });
      return credentialStore.read(userId, credentialId, workspaceId);
    },
  );
  fixture.coordinator.restoreDurableRunnerGates();

  await recoverRunner(fixture.coordinator, identity.restartId);

  expect(reads).toEqual([
    {
      credentialId: running.credentialId,
      userId: TEST_USER_ID,
      workspaceId: running.workspaceId,
    },
  ]);
  expectLaunches([...scopeLaunches], []);
  expectRestartState(requireCompactionSession(setup.store), identity, "paused");
  expect(fixture.retryDelays).toEqual([1_000]);
  closeCompactionStore(setup);
});

test("credential and launch retries are deduplicated and stop after recovery", async () => {
  const { identity, setup } = pausedRunnerRestartStore("restart-credential");
  let credentialAvailable = false;

  let launchAvailable = false;
  const launches: string[] = [];
  const fixture = restartCoordinatorFixture(
    setup,
    (detail) => {
      if (launchAvailable) {
        launches.push(detail.id);
      }
      return launchAvailable;
    },
    TEST_NOW + 3,
    () => (credentialAvailable ? CREDENTIAL : undefined),
  );
  fixture.coordinator.restoreDurableRunnerGates();

  fixture.coordinator.recover(STORE_RUNNER_ID, identity.restartId);
  fixture.coordinator.recover(STORE_RUNNER_ID, identity.restartId);
  await settleRestartRecovery({ steps: 5 });
  expect(fixture.retryDelays).toEqual([1_000]);
  expectLaunches(launches, []);

  credentialAvailable = true;
  fixture.runRetry();
  await settleRestartRecovery({ steps: 5 });
  expectLaunches(launches, []);
  expect(fixture.retryDelays).toEqual([1_000, 2_000]);

  launchAvailable = true;
  fixture.runRetry();
  await settleRestartRecovery({ steps: 5 });
  expect(launches).toEqual([identity.sessionId]);
  expect(fixture.retryDelays).toEqual([1_000, 2_000]);
  closeCompactionStore(setup);
});

test("recreated runtimes keep conflicting durable handoffs fail-closed", async () => {
  const first = pausedRunnerRestartStore("restart-conflict-one");
  const running = requireCompactionSession(first.setup.store);
  const conflictingHandoff = {
    executionGeneration: running.generation + 1,
    operation: "agent" as const,
    pendingInput: [],
    requestedBy: "runner" as const,
    restartId: "restart-conflict-two",
  };
  const stored = first.setup.database.select().from(agentSessions).get();
  if (stored === undefined) {
    throw new Error("The restart recreation fixture is unavailable");
  }
  first.setup.database
    .insert(agentSessions)
    .values({
      ...stored,
      createdAt: new Date(TEST_NOW + 4),
      executionGeneration: conflictingHandoff.executionGeneration,
      id: "018bcfe5-6800-7000-8000-000000000099",
      restartHandoff: JSON.stringify(conflictingHandoff),
      status: "paused",
      updatedAt: new Date(TEST_NOW + 4),
    })
    .run();

  let launches = 0;
  const fixture = restartCoordinatorFixture(
    first.setup,
    () => {
      launches += 1;
      return true;
    },
    TEST_NOW + 5,
  );

  const coordinator = restoredCoordinator(fixture, { status: "conflicted" });
  for (const restartId of [
    undefined,
    "restart-conflict-one",
    "restart-conflict-two",
  ] as const) {
    await recoverRunner(coordinator, restartId);
  }
  expectRunnerAcceptance(fixture, false);
  expect(launches).toBe(0);
  expect(
    first.setup.store.pendingRestartHandoffs(STORE_RUNNER_ID),
  ).toHaveLength(2);
  closeCompactionStore(first.setup);
});
