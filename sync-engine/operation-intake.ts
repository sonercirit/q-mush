import type { AppDatabase } from "../shared/database";
import { createUuidV7, type IdGenerator } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import {
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_CHECKPOINT_BYTES,
  MAX_OWNER_PARTITION_OPERATIONS,
  MAX_REMOTE_CLOCK_DRIFT_MS,
  operationProtocolError,
  type CausalFrontier,
  type Operation,
  type OperationPartition,
} from "../shared/operation-core";
import {
  applyOperationIntakeBatch,
  initialOperationApplyState,
} from "../shared/operation-intake-core";
import {
  initialOperationEntityProjection,
  operationEntityProjectionCodec,
  reduceOperationEntityProjection,
} from "../shared/operation-projection";
import {
  engineStabilityBoundaryClock,
  stabilizeOperationApplyState,
} from "../shared/operation-stability";
import { createOperationStore } from "./operation-store";

export interface OperationIntakeLimits {
  readonly checkpointBytes?: number;
  readonly ownerPartitionOperations?: number;
}
interface OperationIntakeResources {
  readonly database: AppDatabase;
  readonly generateId?: IdGenerator;
  readonly limits?: OperationIntakeLimits;
}
interface OperationIntakeResult {
  readonly frontier: CausalFrontier;
  readonly encodedCheckpoint: string;
}

export const createOperationIntake = (resources: OperationIntakeResources) => {
  const store = createOperationStore({
    database: resources.database,
    generateId: resources.generateId ?? createUuidV7,
  });
  const checkpointByteLimit =
    resources.limits?.checkpointBytes ?? MAX_OPERATION_CHECKPOINT_BYTES;
  const ownerPartitionOperationLimit =
    resources.limits?.ownerPartitionOperations ??
    MAX_OWNER_PARTITION_OPERATIONS;
  return {
    apply(
      ownerId: string,
      partition: OperationPartition,
      operations: readonly Operation[],
      actorId: string,
      now: number,
    ): OperationIntakeResult {
      if (operations.length > MAX_OPERATION_BATCH_SIZE)
        throw operationProtocolError(
          "invalid",
          "Operation intake batch is too large",
        );
      return resources.database.transaction(() => {
        const encoded = store.loadCheckpoint(ownerId, partition);
        let state =
          encoded === undefined
            ? initialOperationApplyState(initialOperationEntityProjection)
            : decodeOperationCheckpoint(
                encoded,
                operationEntityProjectionCodec,
              );
        const candidates = operations.flatMap((operation) => {
          if (operation.partition !== partition)
            throw operationProtocolError(
              "invalid",
              "Operation intake scope mismatch",
            );
          if (
            store.classifyEnvelopeIdentity(ownerId, operation) === "duplicate"
          )
            return [];
          if (
            Math.abs(operation.clock.physicalMs - now) >
            MAX_REMOTE_CLOCK_DRIFT_MS
          )
            throw operationProtocolError(
              "invalid",
              "Operation clock exceeds remote drift bound",
            );
          return [{ encoded: "", operation }];
        });
        state = applyOperationIntakeBatch(partition, state, candidates, {
          append: (_encoded, snapshot) => {
            store.appendEnvelope(ownerId, snapshot, actorId, now);
          },
          reducer: reduceOperationEntityProjection,
        });
        const boundary = engineStabilityBoundaryClock(now);
        if (boundary !== undefined)
          state = stabilizeOperationApplyState(
            state,
            boundary,
            reduceOperationEntityProjection,
          );
        if (
          state.replayCount + state.pending.length >
          ownerPartitionOperationLimit
        )
          throw operationProtocolError(
            "capacity",
            "Operation history capacity reached",
          );
        const encodedCheckpoint = encodeOperationCheckpoint(
          state,
          operationEntityProjectionCodec,
        );
        if (
          new TextEncoder().encode(encodedCheckpoint).byteLength >
          checkpointByteLimit
        )
          throw operationProtocolError(
            "capacity",
            "Operation checkpoint capacity reached",
          );
        store.storeCheckpoint(
          ownerId,
          partition,
          encodedCheckpoint,
          actorId,
          now,
          state,
        );
        return { frontier: state.frontier, encodedCheckpoint };
      });
    },
  };
};
