import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  RUNNER_EXECUTABLE_PATH,
  RUNNER_EXECUTABLE_SHA256_HEADER,
} from "./routes.ts";

const REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f\d]{64}$/u;
const ENTITY_TAG_PATTERN = /^"[a-f\d]{64}"$/u;

type UpdateFetch = (request: Request) => Promise<Response>;
type LaunchRunner = (
  executablePath: string,
  arguments_: readonly string[],
) => void;

export interface RunnerUpdateContext {
  readonly configurationPath: string;
  readonly executablePath: string;
  readonly serverOrigin: string;
  readonly target: string;
  readonly version: string;
}

interface RunnerUpdateDependencies {
  readonly fetch?: UpdateFetch;
  readonly launch?: LaunchRunner;
}

function launchRunner(
  executablePath: string,
  arguments_: readonly string[],
): void {
  const child = spawn(executablePath, arguments_, {
    detached: true,
    stdio: "inherit",
  });
  child.unref();
}

function executableDownloadRequest(context: RunnerUpdateContext): Request {
  const url = new URL(RUNNER_EXECUTABLE_PATH, context.serverOrigin);
  url.searchParams.set("target", context.target);
  return new Request(url, {
    headers: {
      accept: "application/octet-stream",
      "if-none-match": `"${context.version}"`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
}

function validateUpdateResponse(response: Response): string {
  const digest = response.headers.get(RUNNER_EXECUTABLE_SHA256_HEADER);
  const entityTag = response.headers.get("etag");

  if (digest === null || !SHA256_PATTERN.test(digest)) {
    throw new Error("The runner update has no valid checksum");
  }

  if (entityTag === null || !ENTITY_TAG_PATTERN.test(entityTag)) {
    throw new Error("The runner update has no valid version");
  }

  const contentLength = Number(response.headers.get("content-length"));

  if (Number.isFinite(contentLength) && contentLength > MAX_EXECUTABLE_BYTES) {
    throw new Error("The runner update is too large");
  }

  return digest;
}

async function readVerifiedExecutable(
  response: Response,
  expectedDigest: string,
): Promise<Uint8Array> {
  const executable = new Uint8Array(await response.arrayBuffer());

  if (executable.byteLength > MAX_EXECUTABLE_BYTES) {
    throw new Error("The runner update is too large");
  }

  const actualDigest = createHash("sha256").update(executable).digest("hex");

  if (actualDigest !== expectedDigest) {
    throw new Error("The runner update checksum does not match");
  }

  return executable;
}

function replaceExecutable(path: string, executable: Uint8Array): void {
  const suffix = randomBytes(12).toString("hex");
  const temporaryPath = `${path}.update-${suffix}`;

  try {
    writeFileSync(temporaryPath, executable, { flag: "wx", mode: 0o700 });
    chmodSync(temporaryPath, 0o755);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function updateRunnerIfAvailable(
  context: RunnerUpdateContext,
  dependencies: RunnerUpdateDependencies = {},
): Promise<boolean> {
  const requestUpdate = dependencies.fetch ?? globalThis.fetch;
  const response = await requestUpdate(executableDownloadRequest(context));

  if (response.status === 304) {
    return false;
  }

  if (!response.ok) {
    throw new Error(
      `The Q Mush update server returned status ${String(response.status)}`,
    );
  }

  const expectedDigest = validateUpdateResponse(response);
  const executable = await readVerifiedExecutable(response, expectedDigest);
  replaceExecutable(context.executablePath, executable);
  (dependencies.launch ?? launchRunner)(context.executablePath, [
    "--config",
    context.configurationPath,
  ]);
  return true;
}
