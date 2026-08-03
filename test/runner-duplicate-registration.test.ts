import { expect, test } from "vitest";
import { RunnerConnectionError } from "../runner/runner-connection.ts";
import { completeRunnerRegistration } from "../runner/runner-registration.ts";
import {
  observeOperationalRunnerSocket,
  RunnerSupersededError,
} from "../runner/runner-socket.ts";
import {
  RunnerStartupRestart,
  type RunnerStartupConnection,
} from "../runner/runner-update.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  RunnerCommandBroker,
  RunnerDisconnectedError,
  type RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import {
  RUNNER_SUPERSEDED_CLOSE_CODE,
  runnerConnectMessage,
  runnerSupersededMessage,
} from "../shared/runner-realtime-protocol.ts";
import type {
  createRealtimeIntegration,
  QmushWebSocketData,
} from "../sync-engine/realtime.ts";
import { realtimeSocketMessage } from "../sync-engine/test/realtime-handler-fixtures.ts";
import {
  connectedRunnerRealtimeTestIntegration,
  runnerRestartGate,
} from "../sync-engine/test/realtime-test-helpers.ts";
import {
  assertRealtimeUpgrade,
  realtimeTestSocket,
  type RealtimeTestSocket,
} from "../sync-engine/test/realtime-test-socket-helpers.ts";

const RUNNER_ID = "runner-1";
const RESTART_ID = "restart-duplicate-race";

class FakeRunnerSocket extends EventTarget {
  received: string[] = [];
  readyState: number = WebSocket.OPEN;
  #sendToEngine: (message: string) => void = () => {
    throw new Error("The fake runner process is not connected");
  };

  connect(send: (message: string) => void): void {
    this.#sendToEngine = send;
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  receive(message: string): number {
    if (this.readyState !== WebSocket.OPEN) return 0;
    this.received.push(message);
    queueMicrotask(() => {
      if (this.readyState === WebSocket.OPEN) {
        this.dispatchEvent(new MessageEvent("message", { data: message }));
      }
    });
    return 1;
  }

  send(message: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error("The fake runner process is disconnected");
    }
    this.#sendToEngine(message);
  }
}

interface FakeRunnerProcess {
  readonly client: FakeRunnerSocket;
  readonly registration: Promise<void>;
  readonly server: RealtimeTestSocket;
  readonly startup: RunnerStartupRestart;
  readonly terminated: Promise<void>;
  stopped(): Promise<Error>;
}

function fakeRunnerProcess(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  restartId?: string,
): FakeRunnerProcess {
  const client = new FakeRunnerSocket();
  const startup = new RunnerStartupRestart(restartId);
  const startupConnection: RunnerStartupConnection = startup.connection();
  let stopped: Promise<Error> | undefined;
  const serverData: QmushWebSocketData = assertRealtimeUpgrade(
    realtime,
    "/api/runner/realtime",
  );
  const server = realtimeTestSocket(serverData, {
    close: (code, reason) => {
      client.close(code, reason);
    },
    send: (message) => client.receive(message),
  });
  client.connect((message) => {
    queueMicrotask(() => {
      if (client.readyState === WebSocket.OPEN) {
        realtimeSocketMessage(realtime.websocket, server, message);
      }
    });
  });
  const registration = completeRunnerRegistration(
    client,
    startupConnection,
    () => {
      stopped = observeOperationalRunnerSocket(client);
    },
  );
  client.send(
    runnerConnectMessage(
      {
        architecture: "x64",
        machineId: "machine-duplicate-race",
        name: "runner",
        platform: "linux",
      },
      restartId === undefined ? {} : { restartId },
    ),
  );
  const terminated = registration.then(
    () => new Promise<void>(() => undefined),
    (error: unknown) => {
      if (!startup.startupRestart) {
        throw error;
      }
    },
  );
  return {
    client,
    registration,
    server,
    startup,
    stopped: () => {
      if (stopped === undefined) {
        throw new Error("The fake runner process is not operational");
      }
      return stopped;
    },
    terminated,
  };
}

function runnerCommandInput() {
  return {
    arguments: { command: "sleep 60" },
    executionEnvironment: "bare_metal" as const,
    runnerId: RUNNER_ID,
    sessionId: "session-duplicate-race",
    tool: "bash",
    workingDirectory: "/workspace",
  };
}

function deliverToProcess(
  process: FakeRunnerProcess,
  command: RunnerToolCommand,
): boolean {
  return (
    process.server.send(JSON.stringify({ command, type: "command" })) !== 0
  );
}

function isCommandFrame(message: string, commandId: string): boolean {
  const value: unknown = JSON.parse(message);
  return (
    isRecord(value) &&
    value["type"] === "command" &&
    isRecord(value["command"]) &&
    value["command"]["id"] === commandId
  );
}

test("a supervised relaunch supersedes a stale restart process without rejecting its queued command", async () => {
  let pendingRestartId: string | undefined = RESTART_ID;
  let staleRestartProcess: FakeRunnerProcess | undefined;
  let connectionGeneration = 0;
  let nextCommandId = 0;
  const broker = new RunnerCommandBroker({
    commandId: () =>
      ++nextCommandId === 1
        ? "command-on-stale-restart-process"
        : "queued-command-for-supervised-process",
    deliver: (_runnerId, command) =>
      command.id === "command-on-stale-restart-process" &&
      staleRestartProcess !== undefined
        ? deliverToProcess(staleRestartProcess, command)
        : false,
  });
  const realtime = connectedRunnerRealtimeTestIntegration({
    deliverRunnerCommands: (
      runnerId,
      deliverQueued,
      deliveredGeneration = connectionGeneration,
    ) => {
      broker.deliverQueued(runnerId, deliverQueued, deliveredGeneration);
      return true;
    },
    pendingRunnerRestart: () =>
      pendingRestartId === undefined
        ? { status: "none" }
        : runnerRestartGate(pendingRestartId),
    replaceRunnerConnection: (runnerId, replacedGeneration) => {
      broker.replaceRunnerConnection(runnerId, replacedGeneration);
      connectionGeneration = broker.runnerConnectionGeneration(runnerId);
      staleRestartProcess = undefined;
    },
    runnerConnectionGeneration: () => connectionGeneration,
    runnerRestartReady: (_runnerId, restartId) => {
      if (restartId === pendingRestartId) pendingRestartId = undefined;
    },
  });
  staleRestartProcess = fakeRunnerProcess(realtime, RESTART_ID);
  await expect(staleRestartProcess.registration).resolves.toBeUndefined();

  const commandResult = broker.dispatch({
    ...runnerCommandInput(),
    authorize: () => true,
  });
  const commandRejection = commandResult.catch((error: unknown) => error);
  const queuedResult = broker.dispatch({
    ...runnerCommandInput(),
    authorize: () => true,
  });
  expect(broker.isActive(RUNNER_ID, "command-on-stale-restart-process")).toBe(
    true,
  );
  expect(
    broker.isActive(RUNNER_ID, "queued-command-for-supervised-process"),
  ).toBe(true);

  const supervisedProcess = fakeRunnerProcess(realtime);
  const staleProcess = staleRestartProcess;
  await expect(supervisedProcess.registration).resolves.toBeUndefined();

  expect(supervisedProcess.client.readyState).toBe(WebSocket.OPEN);
  expect(staleProcess.client.readyState).toBe(WebSocket.CLOSED);
  expect(staleProcess.client.received).toContain(runnerSupersededMessage());
  await expect(staleProcess.stopped()).resolves.toEqual(
    new RunnerSupersededError(),
  );
  await expect(commandRejection).resolves.toEqual(
    new RunnerDisconnectedError(
      "The runner connection was superseded before the command returned",
    ),
  );
  expect(
    broker.complete(RUNNER_ID, "queued-command-for-supervised-process", {
      output: "survived replacement",
      state: "completed",
    }),
  ).toBe(true);
  await expect(queuedResult).resolves.toEqual({
    output: "survived replacement",
    state: "completed",
  });
  expect(
    staleProcess.client.received.some((message) =>
      isCommandFrame(message, "command-on-stale-restart-process"),
    ),
  ).toBe(true);
  expect(
    supervisedProcess.client.received.some((message) =>
      isCommandFrame(message, "queued-command-for-supervised-process"),
    ),
  ).toBe(true);
  expect(
    staleProcess.client.received.some((message) =>
      message.includes(String(RUNNER_SUPERSEDED_CLOSE_CODE)),
    ),
  ).toBe(false);
});

test("a stale restart process arriving after the supervised child is rejected once", async () => {
  const realtime = connectedRunnerRealtimeTestIntegration();
  const supervisedProcess = fakeRunnerProcess(realtime);
  await expect(supervisedProcess.registration).resolves.toBeUndefined();

  const staleRestartProcess = fakeRunnerProcess(realtime, RESTART_ID);

  await expect(staleRestartProcess.registration).rejects.toEqual(
    new RunnerConnectionError(
      "The WebSocket connection closed during registration",
    ),
  );
  await expect(staleRestartProcess.terminated).resolves.toBeUndefined();
  expect(staleRestartProcess.startup.restartId).toBe(RESTART_ID);
  expect(staleRestartProcess.client.readyState).toBe(WebSocket.CLOSED);
  expect(staleRestartProcess.client.received).toEqual([]);
  expect(supervisedProcess.client.readyState).toBe(WebSocket.OPEN);

  const command = {
    ...runnerCommandInput(),
    id: "authority-check",
  };
  expect(deliverToProcess(supervisedProcess, command)).toBe(true);
  expect(
    supervisedProcess.client.received.some((message) =>
      isCommandFrame(message, "authority-check"),
    ),
  ).toBe(true);
  expect(staleRestartProcess.client.received).toEqual([]);
});
