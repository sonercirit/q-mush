import type { Database } from "bun:sqlite";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
  type OperationCheckpointProjection,
} from "../shared/operation-checkpoint.ts";
import { type OperationPartition } from "../shared/operation-core.ts";
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
  const state = (ownerId: string, partition: OperationPartition) => {
    const encoded = log.checkpoint(ownerId, partition);
    return encoded === undefined
      ? initialOperationApplyState<OperationCheckpointProjection>([])
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
          partition,
          state(ownerId, partition),
          valid,
          {
            append: (encoded, operation) => {
              log.append(ownerId, operation, encoded, source);
            },
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
