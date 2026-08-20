import { expect, test, vi } from "vitest";
import { DEVELOPMENT_RESTART_LIFECYCLE_MS } from "../../shared/development-shutdown.ts";
import { RestartDeadline } from "../../shared/restart-deadline.ts";
import { SESSION_MODELS_PATH } from "../../shared/routes.ts";
import { DevelopmentRestartLifecycle } from "../../sync-engine/development-restart.ts";
import {
  createAuthenticatedRequest,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { startToolSessionSetup } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  CREDENTIAL_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import { testLivenessClock } from "./session-liveness-test-helpers.ts";
// Leaves the session inside a runner tool call that never completes, so the
// drain cannot reach a handoff boundary and the interrupted marker survives.
import {
  createRestartSessions,
  MultiSessionRestartModel,
} from "./session-restart-step-resume-helpers.ts";

const DRAIN_TIMER_FAILURE = "the restart drain timer failed";

// Fails the first bounded-drain timer the production restart control arms.
// By then SessionIntegrationApi.drain() has already aborted the restart
// signal, disabled interrupted-session recovery and closed the server restart
// gate, so the rejection leaves exactly the degraded state the surviving
// process must repair.
function failingDrainTimer(now: () => number) {
  let failNext = true;
  return {
    now,
    setTimeout: (callback: () => void, delay: number) => {
      if (failNext) {
        failNext = false;
        throw new Error(DRAIN_TIMER_FAILURE);
      }
      return globalThis.setTimeout(callback, delay);
    },
  };
}

function waitForRunnerTool(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<unknown> {
  return waitForSessionValue(
    () => setup.runnerCommands.filter(({ tool }) => tool === "bash").length,
    (value) => value === 1,
  );
}

function restartSessionSetup(failDrainTimer: boolean) {
  const clock = testLivenessClock(1_000, 100, true);
  const setup = connectedSessionSetup(
    new MultiSessionRestartModel(),
    "api_key",
    undefined,
    {
      liveness: clock.dependencies,
      now: clock.now,
      ...(failDrainTimer
        ? { restartTiming: failingDrainTimer(clock.now) }
        : {}),
    },
  );
  return { clock, setup };
}

async function busyRestartSetup() {
  const started = restartSessionSetup(true);
  await startToolSessionSetup(started.setup);
  await waitForRunnerTool(started.setup);
  return started;
}

function restartLifecycle(
  setup: Awaited<ReturnType<typeof busyRestartSetup>>["setup"],
) {
  const events = {
    drainFailed: vi.fn(),
    drainReady: vi.fn(),
    drainSettled: vi.fn(),
    drainStarted: vi.fn(),
    startMaintenance: vi.fn(),
    stopMaintenance: vi.fn(),
  };
  return {
    events,
    lifecycle: new DevelopmentRestartLifecycle({
      ...events,
      sessions: setup.sessions,
    }),
  };
}

function restartDeadline(clock: ReturnType<typeof testLivenessClock>) {
  return new RestartDeadline(
    clock.now() + DEVELOPMENT_RESTART_LIFECYCLE_MS,
    clock.now,
  );
}

function modelsRequest() {
  return createAuthenticatedRequest(
    `${SESSION_MODELS_PATH}?provider=openai&credentialId=${CREDENTIAL_ID}`,
  );
}

test("a rejected development restart leaves the engine fully operational", async () => {
  const { clock, setup } = await busyRestartSetup();
  const { events, lifecycle } = restartLifecycle(setup);
  const running = setup.sessions.listForUser(TEST_USER_ID)[0];
  if (running === undefined) throw new Error("The test session is unavailable");

  await lifecycle.restart(restartDeadline(clock));

  expect(events.drainFailed.mock.calls).toMatchObject([
    [{ message: DRAIN_TIMER_FAILURE }],
  ]);
  expect(events.drainReady).not.toHaveBeenCalled();
  expect(events.stopMaintenance).toHaveBeenCalledTimes(1);
  expect(events.startMaintenance).toHaveBeenCalledTimes(1);
  expect(lifecycle.restarting).toBe(false);

  // The restart gate reopened, so the engine still accepts new sessions.
  expect(await createRestartSessions(setup, 1)).toHaveLength(2);
  // The restart abort signal was replaced, so provider discovery still runs.
  const models = await setup.sessions.models(modelsRequest());
  expect(await models.json()).toMatchObject({ error: "provider_unavailable" });

  // The drain marked the running session interrupted; recovery must restore
  // it now that the drain failed instead of leaving it stranded.
  clock.advance(1);
  clock.scan();
  const recovered = setup.sessions.detailForUser(TEST_USER_ID, running.id);
  expect(recovered?.status).toBe("paused");
  expect(recovered?.generation).toBe(running.generation + 1);
  expect(recovered?.restartHandoff).toMatchObject({ requestedBy: "server" });

  // A later restart request is still accepted; a repeat request escalates it
  // into a force-park so it settles.
  const second = lifecycle.restart(restartDeadline(clock));
  expect(events.drainStarted).toHaveBeenCalledTimes(2);
  await lifecycle.restart(restartDeadline(clock));
  await second;
  expect(events.drainReady).toHaveBeenCalledTimes(1);
  expect(events.drainSettled).toHaveBeenCalledTimes(2);
  closeSessionTestDatabase(setup.database);
});

test("the development restart deadline reaches the production drain", async () => {
  const { clock, setup } = restartSessionSetup(false);
  const deadlines: number[] = [];
  const lifecycle = new DevelopmentRestartLifecycle({
    drainFailed: () => undefined,
    drainReady: () => undefined,
    drainSettled: () => undefined,
    drainStarted: () => undefined,
    sessions: {
      drain: (deadline) => {
        deadlines.push(deadline?.at ?? Number.NaN);
        return setup.sessions.drain(deadline);
      },
      escalateDrain: () => setup.sessions.escalateDrain(),
      restoreDevelopmentDrainRecovery: () => {
        setup.sessions.restoreDevelopmentDrainRecovery();
      },
    },
    startMaintenance: () => undefined,
    stopMaintenance: () => undefined,
  });

  await lifecycle.restart(new RestartDeadline(TEST_NOW + 5_000, clock.now));

  expect(deadlines).toEqual([TEST_NOW + 5_000]);
  closeSessionTestDatabase(setup.database);
});
