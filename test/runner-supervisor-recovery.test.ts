import { expect, test } from "vitest";
import { superviseRunner } from "../runner/runner-supervisor.ts";
import { isRecord } from "../shared/auth-model.ts";
import { TEST_USER_ID } from "../sync-engine/test/authenticated-integration-test-helpers.ts";
import { closeRealtimeSocket } from "../sync-engine/test/realtime-handler-fixtures.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_ID,
} from "../sync-engine/test/session-integration-fixtures.ts";
import { waitForSessionValue } from "../sync-engine/test/session-integration-helpers.ts";
import { closeSessionTestDatabase } from "../sync-engine/test/session-launch-race-helpers.ts";
import {
  durableSessionRunnerReceipt,
  reconnectDurableSessionRunner,
} from "../sync-engine/test/session-restart-runner-continuity-helpers.ts";
import {
  MultiSessionRestartModel,
  nextCommandId,
  restartSessionIds,
  waitForRestartCommands,
  type RestartStepSetup,
} from "../sync-engine/test/session-restart-step-resume-helpers.ts";
import { completeTestRunnerCommands } from "../sync-engine/test/session-runner-command-helpers.ts";

const STOP_SUPERVISOR = new Error("supervisor integration complete");
const EXECUTABLE = "/runner/q-mush-runner";
const CONFIGURATION = "/runner/config";

async function completeCommand(
  setup: RestartStepSetup,
  tool: string,
  output: string,
): Promise<void> {
  const commands = await waitForRestartCommands(setup, tool, 1);
  completeTestRunnerCommands(setup, commands, () => ({
    output,
    state: "completed",
  }));
}

function createGate<Result>(
  gates: PromiseWithResolvers<Result>[],
): Promise<Result> {
  const gate = Promise.withResolvers<Result>();
  gates.push(gate);
  return gate.promise;
}

async function releaseAndWait(
  gate: PromiseWithResolvers<undefined> | undefined,
  connections: readonly unknown[],
  expected: number,
): Promise<void> {
  gate?.resolve(undefined);
  await waitForSessionValue(
    () => connections.length,
    (count) => count === expected,
  );
}

test("the supervisor restores a parked session through a double engine restart", async () => {
  const model = new MultiSessionRestartModel();
  const initial = connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId("supervised-initial"),
  });
  const activationReceipt = durableSessionRunnerReceipt(initial);
  const children: PromiseWithResolvers<number>[] = [];
  const delayGates: PromiseWithResolvers<undefined>[] = [];
  const delays: number[] = [];
  const launches: string[][] = [];
  const connections: ReturnType<typeof reconnectDurableSessionRunner>[] = [];
  let relaunchTarget: RestartStepSetup | undefined;
  const dependencies = {
    delay: (milliseconds: number) => {
      delays.push(milliseconds);
      if (delays.length === 3) throw STOP_SUPERVISOR;
      return createGate(delayGates);
    },
    launch: (executable: string, arguments_: readonly string[]) => {
      launches.push([executable, ...arguments_]);
      const child = Promise.withResolvers<number>();
      children.push(child);
      if (relaunchTarget !== undefined) {
        connections.push(
          reconnectDurableSessionRunner(relaunchTarget, activationReceipt),
        );
      }
      return { kill: () => true, result: child.promise };
    },
    log: () => undefined,
    onSignal: () => undefined,
    removeSignalListener: () => undefined,
  };
  const supervision = superviseRunner(EXECUTABLE, CONFIGURATION, dependencies);

  expect(
    (await initial.sessions.collection(createSessionRequest())).status,
  ).toBe(201);
  const [sessionId] = restartSessionIds(initial);
  if (sessionId === undefined) throw new Error("session missing");
  await completeCommand(initial, "read_agent_file", "null");
  await waitForRestartCommands(initial, "bash", 1);
  const firstDrain = initial.sessions.drain();
  initial.sessions.runnerDisconnected(RUNNER_ID);
  initial.runners.disconnected({ id: RUNNER_ID, userId: TEST_USER_ID });
  children[0]?.resolve(1);
  await firstDrain;
  await waitForSessionValue(
    () => delayGates.length,
    (count) => count === 1,
  );
  expect(initial.sessions.detailForUser(TEST_USER_ID, sessionId)).toMatchObject(
    { restartHandoff: { requestedBy: "server" }, status: "paused" },
  );

  const middle = connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId("supervised-middle"),
    database: initial.database,
  });
  const secondDrain = middle.sessions.drain();
  await Promise.resolve();
  relaunchTarget = middle;
  await releaseAndWait(delayGates[0], connections, 1);
  const raced = connections[0];
  if (raced === undefined) throw new Error("raced relaunch missing");
  closeRealtimeSocket(raced.realtime.websocket, raced.socket);
  children[1]?.resolve(1);
  await secondDrain;
  await waitForSessionValue(
    () => delayGates.length,
    (count) => count === 2,
  );

  const final = connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId("supervised-final"),
    database: initial.database,
  });
  relaunchTarget = final;
  await releaseAndWait(delayGates[1], connections, 2);
  await completeCommand(final, "read_agent_file", "null");
  await completeCommand(
    final,
    "bash",
    "Durable tool output after supervised relaunch.",
  );
  await waitForSessionValue(
    () => final.sessions.detailForUser(TEST_USER_ID, sessionId),
    (detail) =>
      isRecord(detail) &&
      detail["status"] === "idle" &&
      JSON.stringify(detail).includes("Completed after restart."),
  );

  expect(final.sessions.detailForUser(TEST_USER_ID, sessionId)).toMatchObject({
    restartHandoff: null,
    runnerId: RUNNER_ID,
    status: "idle",
  });
  expect(delays).toEqual([5_000, 5_000]);
  expect(launches).toHaveLength(3);
  for (const launch of launches) {
    expect(launch).toEqual([EXECUTABLE, "--config", CONFIGURATION]);
  }
  children[2]?.resolve(0);
  await expect(supervision).rejects.toBe(STOP_SUPERVISOR);
  expect(delays).toEqual([5_000, 5_000, 5_000]);
  closeSessionTestDatabase(initial.database);
});
