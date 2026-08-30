import type { Database } from "bun:sqlite";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
  type OperationCheckpointProjection,
} from "../shared/operation-checkpoint.ts";
import {
  type OperationApplyState,
  type OperationPartition,
} from "../shared/operation-core.ts";
import { applyOperationIntakeBatch } from "../shared/operation-intake-core.ts";
import {
  createRunnerOperationLog,
  type OperationReplicaSource,
} from "./runner-operation-log.ts";

const initialState =
  (): OperationApplyState<OperationCheckpointProjection> => ({
    frontier: {},
    pending: [],
    projection: [],
    applied: undefined,
    replayHead: undefined,
    replayCount: 0,
    replayLastClock: undefined,
    baseProjection: [],
    baseFrontier: {},
  });

export const createRunnerOperationStore = (database: Database) => {
  const log = createRunnerOperationLog(database);
  const state = (ownerId: string, partition: OperationPartition) => {
    const encoded = log.checkpoint(ownerId, partition);
    return encoded === undefined
      ? initialState()
      : decodeOperationCheckpoint(encoded);
  };
  return {
    apply(
      ownerId: string,
      partition: OperationPartition,
      envelopes: readonly string[],
      source: OperationReplicaSource,
    ) {
      const valid: {
        encoded: string;
        operation: ReturnType<typeof decodeOperationEnvelope>;
      }[] = [];
      for (const encoded of envelopes) {
        try {
          valid.push({ encoded, operation: decodeOperationEnvelope(encoded) });
        } catch (error) {
          log.quarantine(
            ownerId,
            partition,
            encoded,
            error instanceof Error
              ? error.message
              : "Invalid operation envelope",
          );
        }
      }
      database.transaction(() => {
        const successor = applyOperationIntakeBatch(
          ownerId,
          partition,
          state(ownerId, partition),
          valid,
          {
            append: (encoded, operation) =>
              log.append(ownerId, operation, encoded, source),
            ownsOperation: (operation) =>
              ownerId === "self" || operation.entity.accountId === ownerId,
            reducer: (projection, operation) => [
              ...projection,
              operation.operationId,
            ],
          },
        );
        log.storeCheckpoint(
          ownerId,
          partition,
          encodeOperationCheckpoint(successor),
        );
      })();
    },
    acknowledge: log.acknowledge,
    inspect: log.inspect,
    pending: log.pending,
    state,
  };
};
