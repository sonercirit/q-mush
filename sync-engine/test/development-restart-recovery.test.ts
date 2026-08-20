import { expect, test, vi } from "vitest";
import { RestartDeadline } from "../../shared/restart-deadline.ts";
import { drainDevelopmentRestart } from "../../sync-engine/development-restart.ts";
import {
  SessionIntegrationApi,
  type SessionIntegrationApiResources,
} from "../../sync-engine/session-integration-api.ts";
import { ShutdownInterruptedSessionStore } from "../../sync-engine/session-shutdown-interrupted-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeCompactionStore,
  runningRestartStore,
} from "./session-compaction-test-helpers.ts";

class DevelopmentDrainApi extends SessionIntegrationApi {
  protected readonly resources: SessionIntegrationApiResources;

  constructor(resources: SessionIntegrationApiResources) {
    super();
    this.resources = resources;
  }
}

function integrationResources(
  shutdownInterrupted: ShutdownInterruptedSessionStore,
  rejectDrain: () => Promise<void>,
): SessionIntegrationApiResources {
  const resources = new Proxy<SessionIntegrationApiResources>(
    Object.create(null),
    {
      get: (_target, property) => {
        if (property === "shutdownInterrupted") return shutdownInterrupted;
        if (property === "restart") return { drainServer: rejectDrain };
        if (property === "restartController") return new AbortController();
        if (property === "executionCleanup") {
          return { drainPending: () => Promise.resolve() };
        }
        if (property === "now") return () => TEST_NOW;
        throw new Error(`Unexpected integration resource: ${String(property)}`);
      },
    },
  );
  return resources;
}

test("a rejected development drain restores liveness marker recovery", async () => {
  const setup = runningRestartStore();
  const listed = setup.store.list(TEST_USER_ID)[0];
  if (listed === undefined) throw new Error("The test session is unavailable");
  const running = setup.store.get(TEST_USER_ID, listed.id);
  if (running === undefined) throw new Error("The test session is unavailable");
  const interrupted = new ShutdownInterruptedSessionStore({
    database: setup.database,
    generateId: () => "recovered-message",
  });
  expect(
    interrupted.mark(
      running.id,
      running.generation,
      "rejected-development-drain",
      "agent",
      TEST_NOW + 1,
    ),
  ).toBe(true);
  interrupted.beginLiveDrain();
  interrupted.recover(() => TEST_NOW + 2);
  const duringDrain = setup.store.get(TEST_USER_ID, running.id);
  expect(duringDrain?.status).toBe("running");
  expect(duringDrain?.generation).toBe(running.generation);
  expect(duringDrain?.restartHandoff).toBeNull();

  const drainError = new Error("drain failed");
  const sessions = new DevelopmentDrainApi(
    integrationResources(interrupted, () => Promise.reject(drainError)),
  );
  await drainDevelopmentRestart(
    sessions,
    new RestartDeadline(TEST_NOW + 1_000, () => TEST_NOW),
    vi.fn(),
  );
  interrupted.recover(() => TEST_NOW + 3);

  expect(setup.store.get(TEST_USER_ID, running.id)).toMatchObject({
    generation: running.generation + 1,
    restartHandoff: { restartId: "rejected-development-drain" },
    status: "paused",
  });
  closeCompactionStore(setup);
});
