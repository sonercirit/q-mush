import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, hostname, networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RUNNER_HEARTBEAT_PATH,
  RUNNER_REGISTER_PATH,
  RUNNER_WORK_PATH,
} from "./routes.ts";
import type { RunnerToolCommand } from "./runner-command-broker.ts";
import {
  executeRunnerCommand,
  readRunnerCommand,
  readRunnerCommandStatus,
} from "./runner-command.ts";
import { RunnerUpdateTrigger } from "./runner-update-trigger.ts";
import { updateRunnerIfAvailable } from "./runner-update.ts";

declare const Q_MUSH_RUNNER_TARGET: string;
declare const Q_MUSH_RUNNER_VERSION: string;

const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;
const WORK_POLL_INTERVAL_MILLISECONDS = 750;
const RETRY_INTERVAL_MILLISECONDS = 5_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const UPDATE_INTERVAL_MILLISECONDS = 5 * 60_000;
const TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;
const runnerUpdateTrigger = new RunnerUpdateTrigger(Q_MUSH_RUNNER_VERSION);

class RunnerRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The Q Mush server returned status ${String(status)}`);
    this.name = "RunnerRequestError";
    this.status = status;
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

function runnerRequestHeaders(
  configuration: RunnerConfiguration,
  hasBody: boolean,
): Headers {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${configuration.token}`,
  });

  if (hasBody) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

interface ServerRequestOptions {
  readonly body?: Readonly<Record<string, string>>;
  readonly method?: string;
}

async function requestServer(
  configuration: RunnerConfiguration,
  path: string,
  options: ServerRequestOptions = {},
): Promise<Response> {
  const requestOptions: RequestInit = {
    headers: runnerRequestHeaders(configuration, options.body !== undefined),
    body: options.body === undefined ? null : JSON.stringify(options.body),
    method: options.method ?? "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  };
  const response = await fetch(
    new URL(path, configuration.serverOrigin),
    requestOptions,
  );
  runnerUpdateTrigger.observe(response);

  if (!response.ok) {
    throw new RunnerRequestError(response.status);
  }

  return response;
}

async function pollForCommand(
  configuration: RunnerConfiguration,
): Promise<RunnerToolCommand | undefined> {
  const response = await requestServer(configuration, RUNNER_WORK_PATH);

  if (response.status === 204) {
    return undefined;
  }

  const value: unknown = await response.json();
  return readRunnerCommand(value);
}

async function commandIsActive(
  configuration: RunnerConfiguration,
  commandId: string,
): Promise<boolean> {
  const response = await requestServer(
    configuration,
    `${RUNNER_WORK_PATH}/${encodeURIComponent(commandId)}`,
    { method: "GET" },
  );
  const value: unknown = await response.json();
  return readRunnerCommandStatus(value);
}

async function executeCancelableCommand(
  configuration: RunnerConfiguration,
  command: RunnerToolCommand,
): Promise<string | undefined> {
  const controller = new AbortController();
  const execution = executeRunnerCommand(command, controller.signal).then(
    (output) => ({ output }),
  );

  for (;;) {
    const outcome = await Promise.race([
      execution,
      sleep(WORK_POLL_INTERVAL_MILLISECONDS).then(() => undefined),
    ]);

    if (outcome !== undefined) {
      return outcome.output;
    }

    try {
      if (!(await commandIsActive(configuration, command.id))) {
        controller.abort();
        await execution;
        return undefined;
      }
    } catch (error) {
      try {
        handleConnectionFailure(
          error,
          "Could not check the agent command; continuing it…",
        );
      } catch (fatalError) {
        controller.abort();
        await execution;
        throw fatalError;
      }
    }
  }
}

async function processOneCommand(
  configuration: RunnerConfiguration,
): Promise<void> {
  const command = await pollForCommand(configuration);

  if (command === undefined) {
    return;
  }

  const output = await executeCancelableCommand(configuration, command);

  if (output === undefined) {
    return;
  }

  await requestServer(
    configuration,
    `${RUNNER_WORK_PATH}/${encodeURIComponent(command.id)}`,
    { body: { output } },
  );
}

function handleConnectionFailure(error: unknown, message: string): void {
  if (
    error instanceof RunnerRequestError &&
    (error.status === 401 || error.status === 409)
  ) {
    throw error;
  }

  console.warn(message);
}

async function connect(
  configuration: RunnerConfiguration,
  configurationPath: string,
): Promise<void> {
  const metadata = {
    architecture: arch(),
    machineId: machineFingerprint(configurationPath),
    name: machineName(),
    platform: platform(),
  };

  for (;;) {
    try {
      await requestServer(configuration, RUNNER_REGISTER_PATH, {
        body: metadata,
      });
      console.log(`Q Mush runner connected as ${metadata.name}.`);
      return;
    } catch (error) {
      handleConnectionFailure(error, "Could not reach Q Mush; retrying setup…");
      await sleep(RETRY_INTERVAL_MILLISECONDS);
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

async function processWithHeartbeats(
  configuration: RunnerConfiguration,
): Promise<void> {
  const outcome = processOneCommand(configuration).then(
    () => ({ status: "completed" as const }),
    (error: unknown) => ({ error, status: "failed" as const }),
  );

  for (;;) {
    const result = await Promise.race([
      outcome,
      sleep(HEARTBEAT_INTERVAL_MILLISECONDS).then(() => undefined),
    ]);

    if (result !== undefined) {
      if (result.status === "failed") {
        throw result.error;
      }

      return;
    }

    await requestServer(configuration, RUNNER_HEARTBEAT_PATH);
  }
}

async function maintainConnection(
  configuration: RunnerConfiguration,
  configurationPath: string,
): Promise<void> {
  let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MILLISECONDS;
  let nextUpdateAt = Date.now() + UPDATE_INTERVAL_MILLISECONDS;

  for (;;) {
    if (runnerUpdateTrigger.take() || Date.now() >= nextUpdateAt) {
      if (await installUpdateIfAvailable(configuration, configurationPath)) {
        return;
      }

      nextUpdateAt = Date.now() + UPDATE_INTERVAL_MILLISECONDS;
    }

    try {
      await processWithHeartbeats(configuration);
    } catch (error) {
      handleConnectionFailure(error, "Q Mush connection lost; retrying…");
      await sleep(RETRY_INTERVAL_MILLISECONDS);
    }

    if (Date.now() >= nextHeartbeatAt) {
      try {
        await requestServer(configuration, RUNNER_HEARTBEAT_PATH);
      } catch (error) {
        handleConnectionFailure(error, "Q Mush connection lost; retrying…");
      }

      nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MILLISECONDS;
    }

    await sleep(WORK_POLL_INTERVAL_MILLISECONDS);
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

  await connect(configuration, configurationPath);
  await maintainConnection(configuration, configurationPath);
}

function reportFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Q Mush runner stopped: ${message}`);
  process.exitCode = 1;
}

await run().catch(reportFatalError);
