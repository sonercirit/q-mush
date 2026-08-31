import { decodeHybridTimestamp } from "../shared/operation-clock-codec.ts";
import {
  type CausalFrontier,
  type HybridTimestamp,
  type OperationPartition,
} from "../shared/operation-core.ts";
import {
  parseSynchronizationFrontier,
  prepareSynchronizationFrontier,
} from "../shared/operation-intake-core.ts";
import { OPERATION_SYNCHRONIZATION_PATH } from "../shared/routes.ts";
import { isRecord } from "../shared/validation.ts";
import type { RunnerOperationRead } from "./runner-operation-sync.ts";

export interface RunnerOperationStability {
  readonly stableClock: HybridTimestamp | null;
  readonly stableFrontier: CausalFrontier | null;
}

export interface OperationSynchronizationHttpError extends Error {
  readonly operationSynchronizationStatus: number;
}

export const isOperationSynchronizationBadRequest = (
  error: unknown,
): error is OperationSynchronizationHttpError =>
  error instanceof Error &&
  "operationSynchronizationStatus" in error &&
  error.operationSynchronizationStatus === 400;

const MAX_SYNCHRONIZATION_ERROR_BODY_BYTES = 4_096;
const MAX_SYNCHRONIZATION_ERROR_BODY_CHARACTERS = 400;
const readSynchronizationErrorBody = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<string> => {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (byteLength < MAX_SYNCHRONIZATION_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_SYNCHRONIZATION_ERROR_BODY_BYTES - byteLength;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      byteLength += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
    if (byteLength >= MAX_SYNCHRONIZATION_ERROR_BODY_BYTES)
      await reader.cancel();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};
const synchronizationHttpError = (
  status: number,
  responseBody: string,
): OperationSynchronizationHttpError => {
  const detail = responseBody
    .slice(0, MAX_SYNCHRONIZATION_ERROR_BODY_CHARACTERS)
    .replaceAll(/\s+/g, " ")
    .trim();
  return Object.assign(
    new Error(
      `Operation synchronization failed (${String(status)})${detail === "" ? "" : `: ${detail}`}`,
    ),
    { operationSynchronizationStatus: status },
  );
};

const parseStability = (value: unknown): RunnerOperationStability => {
  if (!isRecord(value))
    throw new Error("Invalid operation synchronization response");
  const clock = value["stableClock"];
  const frontier = value["stableFrontier"];
  if (clock == null && frontier == null)
    return { stableClock: null, stableFrontier: null };
  if (!isRecord(frontier) || Object.keys(frontier).length > 512)
    throw new Error("Invalid operation synchronization stability");
  const stableClock = decodeHybridTimestamp(
    clock,
    () => new Error("Invalid operation synchronization stability"),
  );
  const decoded = parseSynchronizationFrontier(frontier);
  if (decoded === undefined)
    throw new Error("Invalid operation synchronization stability");
  return {
    stableClock,
    stableFrontier: decoded,
  };
};

const requestJson = async (
  origin: string,
  token: string,
  method: "POST" | "PUT",
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> => {
  const response = await fetch(
    new URL(OPERATION_SYNCHRONIZATION_PATH, origin),
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok)
    throw synchronizationHttpError(
      response.status,
      await readSynchronizationErrorBody(response.body),
    );
  return response.json();
};

export const createRunnerOperationTransport = (
  origin: string,
  token: string,
) => ({
  async readPage({ signal, partition, frontier }: RunnerOperationRead) {
    const value = await requestJson(
      origin,
      token,
      "PUT",
      {
        ownerId: "self",
        partition,
        frontier: prepareSynchronizationFrontier(frontier),
      },
      signal,
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value["envelopes"]) ||
      !value["envelopes"].every((item) => typeof item === "string") ||
      typeof value["hasMore"] !== "boolean"
    )
      throw new Error("Invalid operation synchronization response");
    return {
      envelopes: value["envelopes"],
      hasMore: value["hasMore"],
      ...parseStability(value),
    };
  },
  async writeBatch(
    partition: OperationPartition,
    envelopes: readonly string[],
    signal: AbortSignal,
  ) {
    await requestJson(
      origin,
      token,
      "POST",
      { ownerId: "self", partition, envelopes },
      signal,
    );
  },
});
