import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  RUNNER_EXECUTABLE_PATH,
  RUNNER_EXECUTABLE_SHA256_HEADER,
} from "../shared/routes.ts";
import { replacePrivateFile } from "./runner-private-file.ts";

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
  readonly activationReceipt?: string;
  readonly activationReceiptPhase?: "finalized" | "prepared";
  readonly configurationPath: string;
  readonly executablePath: string;
  readonly restartId?: string;
  readonly serverOrigin: string;
  readonly target: string;
  readonly version: string;
}

interface RunnerUpdateDependencies {
  readonly beforeRestart?: () => Promise<string | undefined>;
  readonly fetch?: UpdateFetch;
  readonly launch?: LaunchRunner;
}

export type RunnerStartupConnection = Readonly<{
  readonly canOperate: (activationReceipt: string) => boolean;
  readonly finalizeActivation: (activationReceipt: string) => boolean;
  readonly operational: (activationReceipt: string) => boolean;
  readonly prepareActivation: (activationReceipt: string) => boolean;
  readonly activationReceipt?: string;
  readonly activationReceiptPhase?: "finalized" | "prepared";
  readonly restartId?: string;
}>;

export interface RunnerStartupRestart {
  readonly activationReceipt: string | undefined;
  readonly activationReceiptPhase: "finalized" | "prepared" | undefined;
  readonly retainedActivationReceipt: string | undefined;
  readonly restartId: string | undefined;
  readonly startupRestart: boolean;
  readonly connection: () => RunnerStartupConnection;
  readonly finalizeActivation: (receipt: string) => void;
  readonly prepareActivation: (receipt: string) => void;
  readonly restoreActivation: (receipt: string, phase?: "finalized" | "prepared") => void;
}

export function createRunnerStartupRestart(restartId?: string): RunnerStartupRestart {
  let activationReceipt: string | undefined;
  let activationReceiptPhase: "finalized" | "prepared" | undefined;
  let connectionGeneration = 0;
  let operationalActivationReceipt: string | undefined;
  let currentRestartId = restartId;
  const restartWasProvided = restartId !== undefined;
  if (
      restartId !== undefined &&
      (restartId.length === 0 || restartId.length > 200)
    ) {
      throw new Error("The runner restart ID is invalid");
    }


  const snapshot = (): RunnerStartupConnection => {
    let snapshotReceipt = activationReceipt;
    let snapshotPhase = activationReceiptPhase;
    const generation = connectionGeneration;
    const restartId = currentRestartId;
    let operational = false;
    const ownsState = (): boolean =>
      !operational &&
      connectionGeneration === generation &&
      currentRestartId === restartId &&
      activationReceipt === snapshotReceipt &&
      activationReceiptPhase === snapshotPhase;
    const retainActivation = (
      receipt: string,
      phase: "finalized" | "prepared",
    ): boolean => {
      if (!ownsState() || receipt.length === 0 || receipt.length > 200) {
        return false;
      }
      snapshotReceipt = receipt;
      snapshotPhase = phase;
      activationReceipt = receipt;
      activationReceiptPhase = phase;
      return true;
    };
    const canOperate = (receipt: string): boolean =>
      ownsState() &&
      snapshotReceipt === receipt &&
      snapshotPhase === "finalized";
    return {
      canOperate,
      finalizeActivation: (receipt) => retainActivation(receipt, "finalized"),
      operational: (receipt) => {
        if (!canOperate(receipt)) {
          return false;
        }
        operational = true;
        operationalActivationReceipt =
          restartId === undefined ? receipt : undefined;
        activationReceipt = undefined;
        activationReceiptPhase = undefined;
        currentRestartId = undefined;
        return true;
      },
      prepareActivation: (receipt) => retainActivation(receipt, "prepared"),
      ...(snapshotReceipt === undefined ? {} : { activationReceipt: snapshotReceipt }),
      ...(snapshotPhase === undefined
        ? {}
        : { activationReceiptPhase: snapshotPhase }),
      ...(restartId === undefined ? {} : { restartId }),
    };
  };

  const connection = (): RunnerStartupConnection => {
    connectionGeneration += 1;
    if (
      activationReceipt === undefined &&
      operationalActivationReceipt !== undefined
    ) {
      activationReceipt = operationalActivationReceipt;
      activationReceiptPhase = "finalized";
    }
    return snapshot();
  };

  const setActivation = (receipt: string, phase: "finalized" | "prepared"): void => {
    if (receipt.length > 0 && receipt.length <= 200) {
      connectionGeneration += 1;
      activationReceipt = receipt;
      activationReceiptPhase = phase;
    }
  };

  const finalizeActivation = (receipt: string): void => {
    setActivation(receipt, "finalized");
  };

  const prepareActivation = (receipt: string): void => {
    setActivation(receipt, "prepared");
  };

  const restoreActivation = (
    receipt: string,
    phase: "finalized" | "prepared" = "finalized",
  ): void => {
    if (phase === "prepared") {
      prepareActivation(receipt);
    } else {
      finalizeActivation(receipt);
    }
  };
  return {
    get activationReceipt() { return activationReceipt; },
    get activationReceiptPhase() { return activationReceiptPhase; },
    get retainedActivationReceipt() { return activationReceipt; },
    get restartId() { return currentRestartId; },
    get startupRestart() { return restartWasProvided; },
    connection, finalizeActivation, prepareActivation, restoreActivation,
  };
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

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_EXECUTABLE_BYTES
    ) {
      throw new Error("The runner update has an invalid size");
    }
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
  replacePrivateFile(path, executable, {
    mode: 0o700,
    prepare: (temporaryPath) => {
      chmodSync(temporaryPath, 0o755);
    },
  });
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
  let restartId = context.restartId;
  restartId ??= await dependencies.beforeRestart?.();
  replaceExecutable(context.executablePath, executable);
  (dependencies.launch ?? launchRunner)(context.executablePath, [
    "--config",
    context.configurationPath,
    ...(restartId === undefined ? [] : ["--restart-id", restartId]),
    ...(context.activationReceipt === undefined
      ? []
      : [
          "--activation-receipt",
          context.activationReceipt,
          "--activation-receipt-phase",
          context.activationReceiptPhase ?? "finalized",
        ]),
  ]);
  return true;
}
