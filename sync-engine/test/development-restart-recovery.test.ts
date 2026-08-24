import { expect, test, vi } from "vitest";
import { DEVELOPMENT_RESTART_LIFECYCLE_MS } from "../../shared/development-shutdown.ts";
import { RestartDeadline } from "../../shared/restart-deadline.ts";
import { SESSION_MODELS_PATH } from "../../shared/routes.ts";
import { DevelopmentRestartLifecycle } from "../../sync-engine/development-restart.ts";
import type { RestartSetTimeout } from "../../sync-engine/session-restart-timers.ts";
import {
  createAuthenticatedRequest,
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { startToolSessionSetup } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  CREDENTIAL_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";
import {
  waitForSessionIdStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import { testLivenessClock } from "./session-liveness-test-helpers.ts";
// Leaves the session inside a runner tool call that never completes, so the
// drain cannot reach a handoff boundary and the interrupted marker survives.
import {
  createRestartSessions,
  createMultiSessionRestartModel,
  nextCommandId,
} from "./session-restart-step-resume-helpers.ts";

function uniqueCommandIds(): () => string {
  const next = nextCommandId("restart-command");
  let first = true;
  return () => {
    if (first) {
      first = false;
      return RUNNER_COMMAND_ID;
    }
    return next();
  };
}

const DRAIN_TIMER_FAILURE = "the restart drain timer failed";
const FAILING_DRAIN_MS = 5_000;

// Fails the next bounded server-drain timer and nothing else: the seam matches
// the timer's own identity, so a timer some future code arms earlier through
// the same seam - whatever its delay - cannot silently retarget these tests.
// By the time it throws, SessionIntegrationApi.drain() has already aborted the
// restart signal, disabled interrupted-session recovery and closed the server
// restart gate, so the rejection leaves exactly the degraded state the
// surviving process must repair.
function drainTimerSeam(now: () => number) {
  let armed = false;
  const failedDelays: number[] = [];
  return {
    armBoundedServerDrainFailure: () => {
      armed = true;
    },
    failedDelays,
    timing: {
      now,
      setTimeout: (
        callback: () => void,
        delay: number,
        purpose: Parameters<RestartSetTimeout>[2],
      ) => {
        if (
          armed &&
          purpose.kind === "bounded_drain" &&
          purpose.scope.kind === "server"
        ) {
          armed = false;
          failedDelays.push(delay);
          throw new Error(DRAIN_TIMER_FAILURE);
        }
        return globalThis.setTimeout(callback, delay);
      },
    },
  };
}

async function waitForRunnerCommand(
  setup: ReturnType<typeof connectedSessionSetup>,
  tool: string,
  sessionId?: string,
  count = 1,
) {
  const matching = () =>
    setup.runnerCommands.filter(
      (command) =>
        command.tool === tool &&
        (sessionId === undefined || command.sessionId === sessionId),
    );
  await waitForSessionValue(
    () => matching().length,
    (value) => value === count,
  );
  const command = matching()[count - 1];
  if (command === undefined) {
    throw new Error("The runner command is unavailable");
  }
  return command;
}

function restartSessionSetup() {
  const clock = testLivenessClock(1_000, 100, true);
  const timers = drainTimerSeam(clock.now);
  const setup = connectedSessionSetup(
    createMultiSessionRestartModel(),
    "api_key",
    undefined,
    {
      // The first command keeps the shared fixture ID the agent-file helper
      // expects; later ones stay distinct so several sessions can run.
      commandId: uniqueCommandIds(),
      liveness: clock.dependencies,
      now: clock.now,
      restartTiming: timers.timing,
    },
  );
  return { clock, setup, timers };
}

// A busy session plus the lifecycle under test, wired to the same fixture.
async function busyRestartLifecycle() {
  const started = await busyRestartSetup();
  return { ...started, ...restartLifecycle(started.setup) };
}

async function busyRestartSetup() {
  const started = restartSessionSetup();
  await startToolSessionSetup(started.setup);
  await waitForRunnerCommand(started.setup, "bash");
  const running = started.setup.sessions.listForUser(TEST_USER_ID)[0];
  if (running === undefined) throw new Error("The test session is unavailable");
  return { ...started, running };
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

function completeRestartCommand(
  setup: ReturnType<typeof connectedSessionSetup>,
  command: Readonly<{ id: string; tool: string }>,
): void {
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, command.id, {
      output:
        command.tool === "read_agent_file" ? "null" : "Durable tool output",
      state: "completed",
    }),
  ).toBe(true);
}

// A second session taken all the way to idle, so a prompt sent while the
// restart gate is closed can only queue.
async function idleRestartSession(
  setup: ReturnType<typeof connectedSessionSetup>,
) {
  await createRestartSessions(setup, 1);
  const detail = setup.sessions.listForUser(TEST_USER_ID)[1];
  if (detail === undefined) throw new Error("The idle session is unavailable");
  const agentFile = await waitForRunnerCommand(
    setup,
    "read_agent_file",
    detail.id,
  );
  completeRestartCommand(setup, agentFile);
  completeRestartCommand(
    setup,
    await waitForRunnerCommand(setup, "bash", detail.id),
  );
  await waitForSessionIdStatus(setup, detail.id, "idle");
  return detail;
}

// Answers every runner command the recovered runs dispatch until they settle,
// so nothing is still writing when the database closes.
async function settleRestartWork(
  setup: ReturnType<typeof connectedSessionSetup>,
  from: number,
): Promise<void> {
  let answered = from;
  await waitForSessionValue(
    () => {
      for (const command of setup.runnerCommands.slice(answered)) {
        answered += 1;
        completeRestartCommand(setup, command);
      }
      return setup.sessions
        .listForUser(TEST_USER_ID)
        .every(({ status }) => status === "idle" || status === "failed");
    },
    (settled) => settled === true,
  );
  await setup.sessions.drainFinal();
}

function restartDeadline(
  clock: ReturnType<typeof testLivenessClock>,
  // The failing bound is the one the timer seam refuses to arm.
  boundMs = DEVELOPMENT_RESTART_LIFECYCLE_MS,
) {
  return new RestartDeadline(clock.now() + boundMs, clock.now);
}

function modelsRequest() {
  return createAuthenticatedRequest(
    `${SESSION_MODELS_PATH}?provider=openai&credentialId=${CREDENTIAL_ID}`,
  );
}

test("a rejected development restart leaves the engine fully operational", async () => {
  const { clock, events, lifecycle, running, setup, timers } =
    await busyRestartLifecycle();

  timers.armBoundedServerDrainFailure();
  await lifecycle.restart(restartDeadline(clock, FAILING_DRAIN_MS));

  // The rejection came from the bounded server-drain timer itself, armed with
  // the bound the supplied deadline left.
  expect(timers.failedDelays).toEqual([FAILING_DRAIN_MS]);
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

  // The abandoned drain must not leave the session parked for a restart that
  // never happened: it keeps running and finishes its work.
  completeRestartCommand(
    setup,
    await waitForRunnerCommand(setup, "bash", running.id),
  );
  await waitForSessionIdStatus(setup, running.id, "idle");
  expect(
    setup.sessions.detailForUser(TEST_USER_ID, running.id)?.restartHandoff,
  ).toBe(null);

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

test("a final shutdown during a rejected drain stays shut down", async () => {
  const { clock, events, lifecycle, setup, timers } =
    await busyRestartLifecycle();

  timers.armBoundedServerDrainFailure();
  const pending = lifecycle.restart(restartDeadline(clock, FAILING_DRAIN_MS));
  // The supervisor's final shutdown request arrives while the drain is still
  // in flight, so its rejection must not undo the shutdown.
  expect(lifecycle.beginFinalShutdown()).toBe(true);
  await pending;

  expect(events.drainFailed).toHaveBeenCalledTimes(1);
  expect(events.stopMaintenance).toHaveBeenCalledTimes(2);
  expect(events.startMaintenance).not.toHaveBeenCalled();
  expect(lifecycle.restarting).toBe(false);
  expect(lifecycle.beginFinalShutdown()).toBe(false);

  // The restart gate stayed closed, so the shutting-down process still
  // refuses new sessions.
  const refused = await setup.sessions.collection(createSessionRequest());
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ error: "server_restarting" });
  closeSessionTestDatabase(setup.database);
});

test("a rejected drain resumes sessions an earlier restart parked", async () => {
  const { clock, running, setup, timers } = await busyRestartSetup();
  const first = restartLifecycle(setup);
  const idle = await idleRestartSession(setup);

  // A completed restart force-parks the busy session into a durable handoff.
  const parking = first.lifecycle.restart(restartDeadline(clock));
  await first.lifecycle.restart(restartDeadline(clock));
  await parking;
  expect(first.events.drainReady).toHaveBeenCalledTimes(1);
  const parked = setup.sessions.detailForUser(TEST_USER_ID, running.id);
  expect(parked?.status).toBe("paused");
  expect(parked?.restartHandoff?.requestedBy).toBe("server");

  // Prompts that arrive while the restart gate is closed only queue.
  const queued = await setup.sessions.realtimeCommands.messageForUser(
    TEST_AUTHENTICATED_USER,
    idle.id,
    { attachments: [], images: [], prompt: "Continue after the restart." },
    TEST_WORKSPACE_ID,
  );
  expect(queued.status).toBe("queued");

  // The supervisor never replaced the process, so a later restart's rejection
  // has to hand the already-parked session back to recovery and launch the
  // work queued while the gate was closed, instead of stranding both.
  timers.armBoundedServerDrainFailure();
  const { events, lifecycle } = restartLifecycle(setup);
  const commandsBefore = setup.runnerCommands.length;
  await lifecycle.restart(restartDeadline(clock));

  expect(events.drainFailed).toHaveBeenCalledTimes(1);
  await waitForSessionValue(
    () =>
      [running.id, idle.id].every(
        (sessionId) =>
          setup.sessions.detailForUser(TEST_USER_ID, sessionId)?.status ===
          "running",
      ),
    (resumed) => resumed === true,
  );
  // Both runs restarted their agent loop on the runner rather than idling in
  // place, each dispatching its own session's first tool call.
  const dispatched = setup.runnerCommands
    .slice(commandsBefore)
    .map(({ sessionId, tool }) => ({ sessionId, tool }))
    .sort((first, second) => first.sessionId.localeCompare(second.sessionId));
  expect(dispatched).toEqual(
    [
      { sessionId: running.id, tool: "read_agent_file" },
      { sessionId: idle.id, tool: "read_agent_file" },
    ].sort((first, second) => first.sessionId.localeCompare(second.sessionId)),
  );

  await settleRestartWork(setup, commandsBefore);
  closeSessionTestDatabase(setup.database);
});
