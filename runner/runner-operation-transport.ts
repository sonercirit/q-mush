import type { OperationPartition } from "../shared/operation-core.ts";
import { prepareSynchronizationFrontier } from "../shared/operation-intake-core.ts";
import { OPERATION_SYNCHRONIZATION_PATH } from "../shared/routes.ts";
import { isRecord } from "../shared/validation.ts";
import type { RunnerOperationRead } from "./runner-operation-sync.ts";

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
    throw new Error(
      `Operation synchronization failed (${String(response.status)})`,
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
    const envelopes: string[] = [];
    for (const item of value["envelopes"])
      if (typeof item === "string") envelopes.push(item);
    return { envelopes, hasMore: value["hasMore"] };
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
