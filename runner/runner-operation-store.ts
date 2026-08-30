import type { Database } from "bun:sqlite";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
  type OperationCheckpointProjection,
} from "../shared/operation-checkpoint.ts";
import {
  isOperationProtocolError,
  type OperationApplyState,
  type OperationPartition,
} from "../shared/operation-core.ts";
import {
  applyOperationIntakeBatch,
  initialOperationApplyState,
} from "../shared/operation-intake-core.ts";
import {
  createRunnerOperationLog,
  type OperationReplicaSource,
} from "./runner-operation-log.ts";

export const createRunnerOperationStore = (database: Database) => {
  const log = createRunnerOperationLog(database);
  const checkpointState = (
    ownerId: string,
    partition: OperationPartition,
  ): OperationApplyState<OperationCheckpointProjection> => {
    const encoded = log.checkpoint(ownerId, partition);
    return encoded === undefined
      ? initialOperationApplyState<OperationCheckpointProjection>([])
      : decodeOperationCheckpoint(encoded);
  };
  const state = (ownerId: string, partition: OperationPartition) => {
    const checkpoint = checkpointState(ownerId, partition);
    const synchronized = log.synchronizationFrontier(ownerId, partition);
    const frontier: Record<string, bigint> = {};
    for (const writerId of new Set([
      ...Object.keys(checkpoint.frontier),
      ...Object.keys(synchronized),
    ])) {
      const checkpointSequence = checkpoint.frontier[writerId] ?? 0n;
      const synchronizedSequence = synchronized[writerId] ?? 0n;
      frontier[writerId] =
        checkpointSequence > synchronizedSequence
          ? checkpointSequence
          : synchronizedSequence;
    }
    return { ...checkpoint, frontier };
  };
  return {
    apply(
      ownerId: string,
      partition: OperationPartition,
      envelopes: readonly string[],
      source: OperationReplicaSource,
    ) {
      if (envelopes.length === 0) return;
      database.transaction(() => {
        let successor = checkpointState(ownerId, partition);
        for (const encoded of envelopes) {
          let operation: ReturnType<typeof decodeOperationEnvelope>;
          try {
            operation = decodeOperationEnvelope(encoded);
          } catch (error) {
            log.quarantine(
              ownerId,
              partition,
              encoded,
              error instanceof Error
                ? error.message
                : "Invalid operation envelope",
            );
            continue;
          }
          try {
            successor = applyOperationIntakeBatch(
              partition,
              successor,
              [{ encoded, operation }],
              {
                append: (candidate, accepted) => {
                  log.append(ownerId, accepted, candidate, source);
                },
                ownsOperation: (accepted) =>
                  accepted.entity.accountId === accepted.writerId,
                reducer: (projection, accepted) => [
                  ...projection,
                  accepted.operationId,
                ],
              },
            );
          } catch (error) {
            if (source !== "remote" || !isOperationProtocolError(error))
              throw error;
            log.quarantine(ownerId, partition, encoded, error.message);
          }
          if (source === "remote")
            log.recordSynchronizationFrontier(
              ownerId,
              partition,
              operation.writerId,
              operation.sequence,
            );
        }
        log.storeCheckpoint(
          ownerId,
          partition,
          encodeOperationCheckpoint(successor),
        );
      })();
    },
    acknowledge: (...arguments_: Parameters<typeof log.acknowledge>) => {
      log.acknowledge(...arguments_);
    },
    inspect: (...arguments_: Parameters<typeof log.inspect>) =>
      log.inspect(...arguments_),
    pending: (...arguments_: Parameters<typeof log.pending>) =>
      log.pending(...arguments_),
    state,
  };
};
