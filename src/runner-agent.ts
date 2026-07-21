import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, hostname, networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseJsonRecord } from "./json-record.ts";
import { RUNNER_REALTIME_PATH } from "./routes.ts";
import type { RunnerToolCommand } from "./runner-command-broker.ts";
import { executeRunnerCommand, readRunnerCommand } from "./runner-command.ts";
import { RunnerUpdateTrigger } from "./runner-update-trigger.ts";
import { updateRunnerIfAvailable } from "./runner-update.ts";
import { createServerWebSocket } from "./server-websocket.ts";

declare const Q_MUSH_RUNNER_TARGET: string;
declare const Q_MUSH_RUNNER_VERSION: string;

const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;
const RETRY_INTERVAL_MILLISECONDS = 5_000;
const UPDATE_INTERVAL_MILLISECONDS = 5 * 60_000;
const TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;
const runnerUpdateTrigger = new RunnerUpdateTrigger(Q_MUSH_RUNNER_VERSION);

class RunnerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConnectionError";
  }
}

interface RunnerConfiguration {
  readonly serverOrigin: string;
  readonly token: string;
}

function readConfigurationPath(): string {
  const argumentIndex = process.argv.indexOf("--config");
  const path = process.argv[argumentIndex + 1];

  if (argumentIndex < 0 || path === undefined || path.length === 0) {
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

interface ActiveCommand {
  readonly controller: AbortController;
}

function parseServerMessage(
  message: string,
): Readonly<Record<string, unknown>> {
  return parseJsonRecord(message, "The server returned an invalid message");
}

function waitForSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: RunnerConnectionError): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    socket.addEventListener(
      "open",
      () => {
        settle();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        settle(new RunnerConnectionError("The WebSocket connection failed"));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => {
        settle(new RunnerConnectionError("The WebSocket connection closed"));
      },
      { once: true },
    );
  });
}

function executeCommand(
  socket: WebSocket,
  command: RunnerToolCommand,
  active: Map<string, ActiveCommand>,
): void {
  if (active.has(command.id)) {
    socket.close(1008, "Duplicate command ID");
    return;
  }

  const controller = new AbortController();
  void executeRunnerCommand(command, controller.signal)
    .then((output) => {
      if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ commandId: command.id, output, type: "result" }),
        );
      }
    })
    .finally(() => {
      active.delete(command.id);
    });
  active.set(command.id, { controller });
}

async function connectRunner(
  configuration: RunnerConfiguration,
  configurationPath: string,
): Promise<WebSocket> {
  const metadata = {
    architecture: arch(),
    machineId: machineFingerprint(configurationPath),
    name: machineName(),
    platform: platform(),
  };

  for (;;) {
    const socket = runnerWebSocket(configuration);

    try {
      await waitForSocket(socket);
      socket.send(JSON.stringify({ ...metadata, type: "connect" }));
      console.log(`Q Mush runner connected as ${metadata.name}.`);
      return socket;
    } catch {
      socket.close();
      console.warn("Could not reach Q Mush; retrying setup…");
      await setTimeout(RETRY_INTERVAL_MILLISECONDS);
    }
  }
}

async function installUpdateIfAvailable(
  configuration: RunnerConfiguration,
  configurationPath: string,
): Promise<boolean> {
  try {
    const updated = await updateRunnerIfAvailable({
      configurationPath,
      executablePath: realpathSync(process.execPath),
      serverOrigin: configuration.serverOrigin,
      target: Q_MUSH_RUNNER_TARGET,
      version: Q_MUSH_RUNNER_VERSION,
    });

    if (updated) {
      console.log("Q Mush runner updated; starting the new version.");
    }

    return updated;
  } catch {
    console.warn("Could not check for a Q Mush runner update; retrying later…");
    return false;
  }
}

function parseRunnerServerMessage(
  message: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return parseServerMessage(message);
  } catch {
    return undefined;
  }
}

async function maintainConnection(
  configuration: RunnerConfiguration,
  configurationPath: string,
): Promise<void> {
  let socket = await connectRunner(configuration, configurationPath);
  const active = new Map<string, ActiveCommand>();
  let nextUpdateAt = Date.now() + UPDATE_INTERVAL_MILLISECONDS;
  const bindSocket = (connected: WebSocket): void => {
    connected.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        connected.close(1003, "Text messages required");
        return;
      }

      const message = parseRunnerServerMessage(event.data);
      if (message === undefined) {
        connected.close(1003, "Invalid server message");
        return;
      }

      if (message["type"] === "ready") {
        const version = message["version"];
        if (typeof version === "string" && version !== Q_MUSH_RUNNER_VERSION) {
          runnerUpdateTrigger.observe(
            new Response(null, {
              headers: { "x-q-mush-runner-version": version },
            }),
          );
        }
      } else if (message["type"] === "command") {
        executeCommand(
          connected,
          readRunnerCommand({ command: message["command"] }),
          active,
        );
      } else if (
        message["type"] === "cancel" &&
        typeof message["commandId"] === "string"
      ) {
        active.get(message["commandId"])?.controller.abort();
      }
    });
    connected.addEventListener("close", () => {
      for (const command of active.values()) {
        command.controller.abort();
      }
      active.clear();
    });
  };
  bindSocket(socket);

  for (;;) {
    if (runnerUpdateTrigger.take() || Date.now() >= nextUpdateAt) {
      if (await installUpdateIfAvailable(configuration, configurationPath)) {
        socket.close(1000, "Updating");
        return;
      }

      nextUpdateAt = Date.now() + UPDATE_INTERVAL_MILLISECONDS;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      socket = await connectRunner(configuration, configurationPath);
      bindSocket(socket);
    }

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "heartbeat" }));
    }
    await setTimeout(HEARTBEAT_INTERVAL_MILLISECONDS);
  }
}

async function run(): Promise<void> {
  if (process.argv.includes("--version")) {
    console.log(`Q Mush runner ${Q_MUSH_RUNNER_VERSION}`);
    return;
  }

  const configurationPath = readConfigurationPath();
  const configuration = readConfiguration(configurationPath);
  writeFileSync(
    join(dirname(configurationPath), "runner.pid"),
    `${String(process.pid)}\n`,
    {
      mode: 0o600,
    },
  );

  if (await installUpdateIfAvailable(configuration, configurationPath)) {
    return;
  }

  await maintainConnection(configuration, configurationPath);
}

function reportFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Q Mush runner stopped: ${message}`);
  process.exitCode = 1;
}

await run().catch(reportFatalError);
