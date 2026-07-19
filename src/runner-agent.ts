import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { RUNNER_HEARTBEAT_PATH, RUNNER_REGISTER_PATH } from "./routes.ts";

const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;
const RETRY_INTERVAL_MILLISECONDS = 5_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;

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

async function postToServer(
  configuration: RunnerConfiguration,
  path: string,
  body?: Readonly<Record<string, string>>,
): Promise<void> {
  const requestOptions: RequestInit = {
    headers: runnerRequestHeaders(configuration, body !== undefined),
    body: body === undefined ? null : JSON.stringify(body),
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  };
  const response = await fetch(
    new URL(path, configuration.serverOrigin),
    requestOptions,
  );

  if (!response.ok) {
    throw new RunnerRequestError(response.status);
  }
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
      await postToServer(configuration, RUNNER_REGISTER_PATH, metadata);
      console.log(`Q Mush runner connected as ${metadata.name}.`);
      return;
    } catch (error) {
      handleConnectionFailure(error, "Could not reach Q Mush; retrying setup…");
      await Bun.sleep(RETRY_INTERVAL_MILLISECONDS);
    }
  }
}

async function maintainConnection(
  configuration: RunnerConfiguration,
): Promise<void> {
  for (;;) {
    await Bun.sleep(HEARTBEAT_INTERVAL_MILLISECONDS);

    try {
      await postToServer(configuration, RUNNER_HEARTBEAT_PATH);
    } catch (error) {
      handleConnectionFailure(error, "Q Mush connection lost; retrying…");
    }
  }
}

async function run(): Promise<void> {
  const configurationPath = readConfigurationPath();
  const configuration = readConfiguration(configurationPath);
  await connect(configuration, configurationPath);
  await maintainConnection(configuration);
}

function reportFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Q Mush runner stopped: ${message}`);
  process.exitCode = 1;
}

await run().catch(reportFatalError);
