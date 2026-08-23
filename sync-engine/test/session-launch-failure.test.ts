import { expect, test, vi } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import {
  createDatabaseWriteResilience,
  startDatabaseRecoveryWatcher,
} from "../database-write-resilience.ts";
import { createEngineHealth } from "../engine-health.ts";
import { SessionStore } from "../session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  closeCompactionStore,
  pauseRestartStore,
  runningRestartStore,
} from "./session-compaction-test-helpers.ts";
import {
  connectedSessionSetup,
  CREDENTIAL_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import {
  expectFailedLaunch,
  launchFailureSetup,
} from "./session-launch-failure-helpers.ts";
import { runLaunchedSession } from "./session-launch-test-helpers.ts";
import {
  createStore,
  createTestSession,
  emptyRuntimes,
} from "./session-store-test-fixtures.ts";

function markerlessStartupSession(database: AppDatabase): void {
  const ids = [
    SESSION_ID,
    "018bcfe5-6800-7000-8000-000000000064",
    "018bcfe5-6800-7000-8000-000000000065",
  ];
  let idIndex = 0;
  const startupStore = new SessionStore(
    database,
    () => {
      const id = ids.at(idIndex);
      idIndex += 1;
      if (id === undefined) {
        throw new Error("No ID remains for the startup recovery fixture");
      }
      return id;
    },
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
  );
  createTestSession(startupStore, TEST_NOW, {
    credentialId: CREDENTIAL_ID,
    runnerId: RUNNER_ID,
  });
  database
    .update(agentSessions)
    .set({ interruptedHandoff: null, restartHandoff: null, status: "queued" })
    .run();
}

function restartLaunchSetup() {
  const storeSetup = runningRestartStore();
  const restart = pauseRestartStore(
    storeSetup,
    "disk-full-restart-launch",
    "agent",
  );
  const claimed = storeSetup.restart.claim(TEST_USER_ID, restart, TEST_NOW + 3);
  if (claimed === undefined) {
    throw new Error("Unable to claim the disk-full restart launch fixture");
  }
  return { detail: claimed, storeSetup };
}

test.each([
  {
    expectedRestartId: undefined,
    label: "ordinary launch",
    setup: () => {
      const storeSetup = createStore();
      return { detail: undefined, storeSetup };
    },
  },
  {
    expectedRestartId: "disk-full-restart-launch",
    label: "restart handoff launch",
    setup: restartLaunchSetup,
  },
])(
  "disk-full $label settlement is reconciled after storage recovers",
  async ({ expectedRestartId, setup: setupStore }) => {
    vi.useFakeTimers();
    let diskFull = true;
    let writeAttempts = 0;
    const health = createEngineHealth(vi.fn());
    const fullError = Object.assign(new Error("database or disk is full"), {
      code: "SQLITE_FULL",
    });
    const { detail, storeSetup } = setupStore();
    const setup = launchFailureSetup(
      storeSetup,
      createDatabaseWriteResilience({
        attempt: (operation) => {
          writeAttempts += 1;
          if (diskFull && writeAttempts !== 5) throw fullError;
          return operation();
        },
        health,
        sleep: () => undefined,
      }),
      TEST_NOW + 3,
      detail,
    );
    const recoveryTimer = startDatabaseRecoveryWatcher(
      setup.storeSetup.database.$client,
      health,
      setup.reconcile,
      setup.hasPendingReconciliation,
    );
    await setup.runtimes.settled(setup.detail.id);
    diskFull = false;
    expect(writeAttempts).toBeGreaterThanOrEqual(9);
    const queuedId = setup.detail.id;
    const queued = setup.storeSetup.store.get(TEST_USER_ID, queuedId);
    expect(queued).toMatchObject({
      messages: [{ role: "user" }],
      status: "queued",
    });
    expect(queued?.restartHandoff?.restartId).toBe(expectedRestartId);
    expect(setup.runtimes.active(queuedId)).toBe(false);
    expect(setup.hasPendingReconciliation()).toBe(true);

    let unrelatedAttempts = 0;
    const unrelatedWrite = createDatabaseWriteResilience({
      attempt(operation) {
        const thisAttempt = unrelatedAttempts;
        unrelatedAttempts += 1;
        if (thisAttempt === 0) {
          throw fullError;
        }
        return operation();
      },
      health,
      sleep: vi.fn(),
    });
    unrelatedWrite.run("critical", () => undefined);
    expect(unrelatedAttempts).toBe(2);
    expect(health.snapshot().reasons).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);

    expectFailedLaunch(setup);
    const continued = setup.storeSetup.store.queue(
      TEST_USER_ID,
      setup.detail.id,
      TEST_NOW + 6,
    );
    expect(continued.status).toBe("queued");
    if (continued.status !== "queued") {
      throw new Error("The failed launch was not continuable");
    }
    await runLaunchedSession({
      broker: setup.broker,
      detail: continued.detail,
      launcher: setup.launcher,
      runtimes: setup.runtimes,
    });
    const recovered = setup.storeSetup.store.get(TEST_USER_ID, queuedId);
    expect(recovered?.activeStartedAt).toBeNull();
    expect(recovered?.status).toBe("idle");
    expect(recovered?.messages.at(-1)).toMatchObject({
      content: "Continued after recovery.",
      role: "assistant",
    });

    clearInterval(recoveryTimer);
    vi.useRealTimers();
    setup.finished.mockRestore();
    closeCompactionStore(setup.storeSetup);
  },
);

test("startup queued-session recovery launches a marker-less row", async () => {
  const model = new ScriptedAgentModel([
    providerStep("Recovered after restart."),
  ]);
  const initial = connectedSessionSetup(model);
  const originalDatabase = initial.database;
  markerlessStartupSession(originalDatabase);

  const recreated = connectedSessionSetup(model, "api_key", undefined, {
    database: originalDatabase,
  });
  const command = await waitForSessionValue(
    () => recreated.latestRunnerCommand(),
    (value) => value !== undefined,
  );
  expect(command).toMatchObject({ sessionId: SESSION_ID });

  originalDatabase.$client.close();
});
