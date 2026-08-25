import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { arch, hostname, networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describeError } from "../shared/error.ts";
import { RUNNER_REALTIME_PATH } from "../shared/routes.ts";
import {
  encodeRunnerActivationReceipt,
  runnerConnectMessage,
} from "../shared/runner-realtime-protocol.ts";
import { createServerWebSocket } from "../shared/server-websocket.ts";
import { catchUpAccountExport } from "./runner-account-export-client.ts";
import { createAnonymousRunnerIdentity } from "./runner-anonymous-identity.ts";
import { createRunnerAppHandler } from "./runner-app-server.ts";
import {
  createRunnerCommandExecutions,
  type RunnerCommandExecutions,
} from "./runner-command-executions.ts";
import {
  createRunnerCommandExecutor,
  readRunnerCommand,
  type RunnerCommandExecutor,
} from "./runner-command.ts";
import {
  createRunnerConnectionError,
  createRunnerConnectionSettlement,
} from "./runner-connection.ts";
import {
  createRunnerContainerManager,
  type RunnerContainerManager,
} from "./runner-container.ts";
import { embeddedClientRelease } from "./runner-embedded-client-release.ts";
import { reportRunnerFatalError } from "./runner-fatal-error.ts";
import { completeRunnerRegistration } from "./runner-registration.ts";
import { createRunnerReplicaStore } from "./runner-replica-store.ts";
import { createRunnerRestartCoordinator } from "./runner-restart.ts";
import { sendOpenRunnerSocketMessage } from "./runner-socket-send.ts";
import {
  addRunnerSocketFailureListeners,
  isRunnerRegistrationRejectedError,
  isRunnerSupersededError,
  observeOperationalRunnerSocket,
  parseSocketJsonRecord,
} from "./runner-socket.ts";
import { createRunnerUpdateTrigger } from "./runner-update-trigger.ts";
import {
  createRunnerStartupRestart,
  type RunnerStartupRestart,
  updateRunnerIfAvailable,
} from "./runner-update.ts";

declare const Q_MUSH_RUNNER_TARGET: string;
declare const Q_MUSH_RUNNER_VERSION: string;
declare const Q_MUSH_CLIENT_RELEASE: string;

const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;
const RETRY_INTERVAL_MILLISECONDS = 5_000;
const UPDATE_INTERVAL_MILLISECONDS = 5 * 60_000;
const TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;
const RUNNER_PROCESS_NONCE = randomBytes(32).toString("base64url");
const runnerUpdateTrigger = createRunnerUpdateTrigger(Q_MUSH_RUNNER_VERSION);
const runnerRestart = createRunnerRestartCoordinator({
  restartId: () => randomBytes(32).toString("base64url"),
});

interface RunnerExecution {
  readonly commands: RunnerCommandExecutor;
  readonly containers: RunnerContainerManager;
}

let runnerExecution: RunnerExecution | undefined;

function activeRunnerExecution(): RunnerExecution {
  if (runnerExecution === undefined) {
    throw new Error("The runner execution services are not initialized");
  }
  return runnerExecution;
}

interface RunnerConfiguration {
  readonly serverOrigin: string;
  readonly token: string;
}

function readArgument(
  name:
    | "--activation-receipt"
    | "--activation-receipt-phase"
    | "--config"
    | "--restart-id",
): string | undefined {
  const indexes = process.argv.flatMap((argument, index) =>
    argument === name ? [index] : [],
  );
  if (indexes.length > 1) {
    throw new Error(
      `The Q Mush runner ${name.slice(2)} argument is duplicated`,
    );
  }
  const index = indexes[0];
  return index === undefined ? undefined : process.argv[index + 1];
}

function isArgumentName(value: string): boolean {
  return (
    value === "--activation-receipt" ||
    value === "--activation-receipt-phase" ||
    value === "--config" ||
    value === "--restart-id"
  );
}

function readRestartId(): string | undefined {
  const restartId = readArgument("--restart-id");
  if (restartId === undefined) {
    return undefined;
  }
  if (
    isArgumentName(restartId) ||
    restartId.length === 0 ||
    restartId.length > 200
  ) {
    throw new Error("The Q Mush runner restart ID is invalid");
  }
  return restartId;
}

function readActivationReceipt(): string | undefined {
  const receipt = readArgument("--activation-receipt");
  if (
    receipt !== undefined &&
    (isArgumentName(receipt) || receipt.length === 0 || receipt.length > 200)
  ) {
    throw new Error("The Q Mush runner activation receipt is invalid");
  }
  return receipt;
}

function readActivationReceiptPhase(): "finalized" | "prepared" | undefined {
  const phase = readArgument("--activation-receipt-phase");
  if (phase === undefined) {
    return undefined;
  }
  if (phase !== "finalized" && phase !== "prepared") {
    throw new Error("The Q Mush runner activation receipt phase is invalid");
  }
  return phase;
}

function readConfigurationPath(): string | undefined {
  const path = readArgument("--config");

  if (path !== undefined && (isArgumentName(path) || path.length === 0)) {
    throw new Error("Start the Q Mush runner with --config <path>");
  }

  return path;
}

function readConfiguration(path: string): RunnerConfiguration {
  const [serverValue, tokenValue] = readFileSync(path, "utf8").split(/\r?\n/u);

  if (serverValue === undefined || tokenValue === undefined) {
    throw new Error("The Q Mush runner configuration is incomplete");
  }

  const server = new URL(serverValue);

  if (
    (server.protocol !== "http:" && server.protocol !== "https:") ||
    server.origin !== serverValue
  ) {
    throw new Error("The Q Mush runner server must be an HTTP(S) origin");
  }

  if (!TOKEN_PATTERN.test(tokenValue)) {
    throw new Error("The Q Mush runner setup token is invalid");
  }

  return { serverOrigin: server.origin, token: tokenValue };
}

function readOperatingSystemMachineId(): string | undefined {
  if (platform() === "linux") {
    try {
      const machineId = readFileSync("/etc/machine-id", "utf8").trim();

      if (machineId.length > 0) {
        return machineId;
      }
    } catch {
      // Fall back to stable network hardware below.
    }
  }

  const hardwareAddresses = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter(({ internal, mac }) => !internal && mac !== "00:00:00:00:00:00")
    .map(({ mac }) => mac)
    .sort();
  return hardwareAddresses[0];
}

function readFallbackMachineId(configurationPath: string): string {
  const path = join(dirname(configurationPath), "machine-id");

  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }

  const id = randomBytes(32).toString("base64url");
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

function machineFingerprint(configurationPath: string): string {
  const machineId =
    readOperatingSystemMachineId() ?? readFallbackMachineId(configurationPath);
  return createHash("sha256")
    .update(`${platform()}:${machineId}`)
    .digest("hex");
}

function machineName(): string {
  const normalized = hostname()
    .replaceAll(/[^A-Za-z\d._ -]/gu, "-")
    .slice(0, 100)
    .trim();
  return normalized.length === 0 ? "Q Mush runner" : normalized;
}

function runnerWebSocketUrl(configuration: RunnerConfiguration): string {
  const url = new URL(RUNNER_REALTIME_PATH, configuration.serverOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function runnerWebSocket(configuration: RunnerConfiguration): WebSocket {
  return createServerWebSocket(
    runnerWebSocketUrl(configuration),
    { authorization: `Bearer ${configuration.token}` },
    "The runtime does not support runner WebSockets",
  );
}

function waitForSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const { settle } = createRunnerConnectionSettlement(resolve, reject);
    socket.addEventListener(
      "open",
      () => {
        settle();
      },
      { once: true },
    );
    addRunnerSocketFailureListeners(socket, settle, {
      close: "The WebSocket connection closed",
      error: "The WebSocket connection failed",
    });
  });
}

function bindOperationalSocket(
  connected: WebSocket,
  active: RunnerCommandExecutions,
): void {
  connected.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      connected.close(1003, "Text messages required");
      return;
    }

    const message = parseSocketJsonRecord(event.data);
    if (message === undefined) {
      connected.close(1003, "Invalid server message");
      return;
    }

    if (message["type"] === "superseded") {
      return;
    }
    if (message["type"] === "command") {
      active.execute(
        connected,
        readRunnerCommand({ command: message["command"] }),
      );
    } else if (
      message["type"] === "cancel" &&
      typeof message["commandId"] === "string"
    ) {
      active.cancel(connected, message["commandId"]);
    } else if (
      message["type"] === "result_received" &&
      typeof message["commandId"] === "string"
    ) {
      active.resultReceived(message["commandId"]);
    } else if (message["type"] !== "restart_ready") {
      connected.close(1003, "Invalid server message");
    }
  });
}

async function connectRunner(
  configuration: RunnerConfiguration,
  configurationPath: string,
  startupRestart: RunnerStartupRestart,
  installOperationalHandlers: (socket: WebSocket) => void,
  onOperational: (socket: WebSocket) => void,
): Promise<WebSocket> {
  const metadata = {
    architecture: arch(),
    machineId: machineFingerprint(configurationPath),
    name: machineName(),
    platform: platform(),
  };

  for (;;) {
    const socket = runnerWebSocket(configuration);
    const startupConnection = runnerRestart.connectionContext(
      startupRestart.connection(),
    );

    try {
      await waitForSocket(socket);
      try {
        socket.send(
          runnerConnectMessage(metadata, {
            ...(startupConnection.activationReceipt === undefined
              ? {}
              : {
                  activationReceipt: encodeRunnerActivationReceipt({
                    value: startupConnection.activationReceipt,
                  }),
                }),
            ...(startupConnection.restartId === undefined
              ? {}
              : { restartId: startupConnection.restartId }),
            processNonce: RUNNER_PROCESS_NONCE,
          }),
        );
      } catch {
        throw createRunnerConnectionError(
          "The WebSocket connection message could not be sent",
        );
      }
      await completeRunnerRegistration(
        socket,
        startupConnection,
        () => {
          installOperationalHandlers(socket);
        },
        {
          onOperational: (restartId) => runnerRestart.operational(restartId),
          onVersion: (version) => {
            if (version !== Q_MUSH_RUNNER_VERSION) {
              runnerUpdateTrigger.observe(
                new Response(null, {
                  headers: { "x-q-mush-runner-version": version },
                }),
              );
            }
          },
        },
      );
      onOperational(socket);
      console.log(`Q Mush runner connected as ${metadata.name}.`);
      return socket;
    } catch (error) {
      socket.close();
      if (
        isRunnerRegistrationRejectedError(error) ||
        isRunnerSupersededError(error)
      ) {
        throw error;
      }
      console.warn("Could not reach Q Mush; retrying setup…");
      await setTimeout(RETRY_INTERVAL_MILLISECONDS);
    }
  }
}

type RunnerUpdateArguments = readonly [
  configuration: RunnerConfiguration,
  configurationPath: string,
  restartId?: string,
  activationReceipt?: string,
  activationReceiptPhase?: "finalized" | "prepared",
];

function runnerUpdateContext(
  ...[
    configuration,
    configurationPath,
    restartId,
    activationReceipt,
    activationReceiptPhase,
  ]: RunnerUpdateArguments
) {
  return {
    ...(activationReceipt === undefined
      ? {}
      : {
          activationReceipt,
          activationReceiptPhase: activationReceiptPhase ?? "finalized",
        }),
    configurationPath,
    executablePath: realpathSync(process.execPath),
    ...(restartId === undefined ? {} : { restartId }),
    serverOrigin: configuration.serverOrigin,
    target: Q_MUSH_RUNNER_TARGET,
    version: Q_MUSH_RUNNER_VERSION,
  };
}

async function installUpdateIfAvailable(
  ...[
    configuration,
    configurationPath,
    restartId,
    activationReceipt,
    activationReceiptPhase,
    beforeRestart,
  ]: readonly [
    ...RunnerUpdateArguments,
    beforeRestart?: () => Promise<string | undefined>,
  ]
): Promise<boolean> {
  try {
    const updated = await updateRunnerIfAvailable(
      runnerUpdateContext(
        configuration,
        configurationPath,
        restartId,
        activationReceipt,
        activationReceiptPhase,
      ),
      beforeRestart === undefined || restartId !== undefined
        ? {}
        : { beforeRestart },
    );

    if (updated) {
      console.log("Q Mush runner updated; starting the new version.");
    }

    return updated;
  } catch {
    console.warn("Could not check for a Q Mush runner update; retrying later…");
    return false;
  }
}

async function pendingSocketFailure(
  failure: Promise<Error>,
  milliseconds: number,
): Promise<Error | undefined> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      setTimeout(milliseconds, undefined, {
        signal: controller.signal,
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          throw error;
        }
        return undefined;
      }),
      failure,
    ]);
  } finally {
    controller.abort();
  }
}

async function pendingSupersession(
  socket: WebSocket,
  active: RunnerCommandExecutions,
  failure: Promise<Error>,
  milliseconds: number,
): Promise<void> {
  const pending = await pendingSocketFailure(failure, milliseconds);
  if (isRunnerSupersededError(pending)) {
    await throwSocketFailure(socket, active, pending);
  }
}

async function throwSocketFailure(
  socket: WebSocket,
  active: RunnerCommandExecutions,
  failure: Error,
): Promise<never> {
  if (isRunnerSupersededError(failure)) {
    socket.close(1000, "Superseded");
    active.abortAll();
    await activeRunnerExecution().containers.cleanupAll();
  }
  throw failure;
}

async function maintainConnection(
  configuration: RunnerConfiguration,
  configurationPath: string,
  startupRestart: RunnerStartupRestart,
): Promise<void> {
  const active = createRunnerCommandExecutions(
    activeRunnerExecution().commands,
  );
  const installOperationalHandlers = (connected: WebSocket): void => {
    bindOperationalSocket(connected, active);
  };
  const establishConnection = () =>
    connectRunner(
      configuration,
      configurationPath,
      startupRestart,
      installOperationalHandlers,
      (connected) => {
        active.connected(connected);
      },
    );
  let socket = await establishConnection();
  let socketFailure = observeOperationalRunnerSocket(socket);
  let initialUpdatePending = true;
  let nextUpdateAt = Date.now() + UPDATE_INTERVAL_MILLISECONDS;

  for (;;) {
    if (socket.readyState !== WebSocket.OPEN) {
      const failure = await socketFailure;
      if (isRunnerSupersededError(failure)) {
        await throwSocketFailure(socket, active, failure);
      }
      socket = await establishConnection();
      socketFailure = observeOperationalRunnerSocket(socket);
    }

    if (socket.readyState === WebSocket.OPEN) {
      await pendingSupersession(socket, active, socketFailure, 0);
    }

    if (
      initialUpdatePending ||
      runnerRestart.pending ||
      runnerUpdateTrigger.take() ||
      Date.now() >= nextUpdateAt
    ) {
      initialUpdatePending = false;
      if (
        await installUpdateIfAvailable(
          configuration,
          configurationPath,
          startupRestart.restartId,
          startupRestart.retainedActivationReceipt,
          startupRestart.activationReceiptPhase,
          () => runnerRestart.request(socket),
        )
      ) {
        socket.close(1000, "Updating");
        active.abortAll();
        await activeRunnerExecution().containers.cleanupAll();
        return;
      }

      nextUpdateAt = Date.now() + UPDATE_INTERVAL_MILLISECONDS;
    }

    sendOpenRunnerSocketMessage(socket, { type: "heartbeat" });
    await pendingSupersession(
      socket,
      active,
      socketFailure,
      HEARTBEAT_INTERVAL_MILLISECONDS,
    );
  }
}

async function run(): Promise<void> {
  if (process.argv.includes("--version")) {
    console.log(`Q Mush runner ${Q_MUSH_RUNNER_VERSION}`);
    return;
  }

  const configurationPath = readConfigurationPath();
  const runnerDirectory =
    configurationPath === undefined
      ? join(process.env["HOME"] ?? process.cwd(), ".q-mush", "runner")
      : dirname(configurationPath);
  mkdirSync(runnerDirectory, { recursive: true });
  const runnerRestartId = readRestartId();
  const startupRestart = createRunnerStartupRestart(runnerRestartId);
  if (runnerRestartId !== undefined) runnerRestart.restore(runnerRestartId);
  const activationReceipt = readActivationReceipt();
  const activationReceiptPhase = readActivationReceiptPhase();
  if (activationReceipt === undefined && activationReceiptPhase !== undefined) {
    throw new Error(
      "The Q Mush runner activation receipt phase has no receipt",
    );
  }
  if (activationReceipt !== undefined) {
    startupRestart.restoreActivation(
      activationReceipt,
      activationReceiptPhase ?? "finalized",
    );
  }
  const configuration =
    configurationPath === undefined
      ? undefined
      : readConfiguration(configurationPath);
  const containers = createRunnerContainerManager({
    trackingPath: join(runnerDirectory, "owned-containers.json"),
  });
  runnerExecution = {
    commands: createRunnerCommandExecutor(containers),
    containers,
  };
  writeFileSync(
    join(runnerDirectory, "runner.pid"),
    `${String(process.pid)}\n`,
    { mode: 0o600 },
  );

  const replicaDirectory = join(runnerDirectory, "replica");
  if (configuration && configurationPath) {
    void catchUpAccountExport(
      replicaDirectory,
      configurationPath,
      configuration.serverOrigin,
      configuration.token,
    ).catch((error: unknown) => {
      console.error(`Replica catch-up deferred: ${describeError(error)}`);
    });
  }
  const replica = createRunnerReplicaStore(replicaDirectory);
  const identity = createAnonymousRunnerIdentity(
    replicaDirectory,
    Date.now(),
    process.env["Q_MUSH_PAIRING_CODE"],
    process.env["Q_MUSH_PAIRING_TRANSCRIPT"],
  );
  const requestedAppPort = Number(process.env["Q_MUSH_LOCAL_APP_PORT"] ?? "0");
  let handler: ((request: Request) => Response) | undefined;
  const app = Bun.serve({
    fetch(request) {
      handler ??= createRunnerAppHandler(
        embeddedClientRelease(
          typeof Q_MUSH_CLIENT_RELEASE === "undefined"
            ? undefined
            : Q_MUSH_CLIENT_RELEASE,
        ),
        `http://127.0.0.1:${String(app.port)}`,
        { pairing: identity.pairing, views: replica },
      );
      return handler(request);
    },
    hostname: "127.0.0.1",
    port:
      Number.isSafeInteger(requestedAppPort) && requestedAppPort >= 0
        ? requestedAppPort
        : 0,
  });
  console.log(`App: http://127.0.0.1:${String(app.port)}`);
  console.log(`Pairing code: ${identity.pairing.code}`);
  await containers.recoverTracked();
  try {
    if (!configuration || !configurationPath) {
      await new Promise<void>(() => undefined);
    } else {
      await maintainConnection(
        configuration,
        configurationPath,
        startupRestart,
      );
    }
  } finally {
    await app.stop();
    replica.close();
  }
}

await run().catch(reportRunnerFatalError);
