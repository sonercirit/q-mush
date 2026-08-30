import type { Database } from "bun:sqlite";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
  type OperationCheckpointProjection,
} from "../shared/operation-checkpoint.ts";
import {
  isOperationProtocolError,
  MAX_OPERATION_CHECKPOINT_BYTES,
  operationProtocolError,
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

const checkpointByteLength = (value: string): number =>
  Buffer.byteLength(value, "utf8");

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
        let stalled = source === "remote" && log.stalled(ownerId, partition);
        for (const encoded of envelopes) {
          let operation: ReturnType<typeof decodeOperationEnvelope>;
          try {
            operation = decodeOperationEnvelope(encoded);
          } catch (error) {
            if (source === "local") throw error;
            log.quarantine(
              ownerId,
              partition,
              encoded,
              error instanceof Error
                ? error.message
                : "Invalid operation envelope",
            );
            stalled = true;
            continue;
          }
          if (stalled) continue;
          try {
            let acceptedOperation: typeof operation | undefined;
            const candidate = applyOperationIntakeBatch(
              partition,
              successor,
              [{ encoded, operation }],
              {
                append: (_candidate, accepted) => {
                  acceptedOperation = accepted;
                },
                ownsOperation: (accepted) =>
                  accepted.entity.accountId === accepted.writerId,
                reducer: (projection, accepted) => [
                  ...projection,
                  accepted.operationId,
                ],
              },
            );
            const encodedCheckpoint = encodeOperationCheckpoint(candidate);
            if (
              checkpointByteLength(encodedCheckpoint) >
              MAX_OPERATION_CHECKPOINT_BYTES
            )
              throw operationProtocolError(
                "capacity",
                "Operation checkpoint capacity reached",
              );
            if (acceptedOperation !== undefined)
              log.append(ownerId, acceptedOperation, encoded, source);
            successor = candidate;
          } catch (error) {
            if (source !== "remote" || !isOperationProtocolError(error))
              throw error;
            log.quarantine(
              ownerId,
              partition,
              encoded,
              error.message,
              operation,
            );
            stalled = true;
          }
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
    rejectOutbox: (...rejection: Parameters<typeof log.rejectOutbox>) => {
      log.rejectOutbox(...rejection);
    },
    state(ownerId: string, partition: OperationPartition) {
      return {
        ...checkpointState(ownerId, partition),
        stalled: log.stalled(ownerId, partition),
      };
    },
  };
};
