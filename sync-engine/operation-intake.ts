import type { AppDatabase } from "../shared/database";
import { createUuidV7, type IdGenerator } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
  type OperationCheckpointProjection,
} from "../shared/operation-checkpoint";
import {
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_CHECKPOINT_BYTES,
  MAX_OWNER_PARTITION_OPERATIONS,
  operationProtocolError,
  type CausalFrontier,
  type Operation,
  type OperationPartition,
} from "../shared/operation-core";
import {
  applyOperationIntakeBatch,
  initialOperationApplyState,
} from "../shared/operation-intake-core";
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
      reducer: (
        projection: OperationCheckpointProjection,
        operation: Operation,
      ) => OperationCheckpointProjection,
      actorId: string,
      now: number,
    ): OperationIntakeResult {
      if (operations.length > MAX_OPERATION_BATCH_SIZE)
        throw operationProtocolError(
          "invalid",
          "Operation intake batch is too large",
        );
      return resources.database.transaction(() => {
        let storedCount = store.countEnvelopes(ownerId, partition);
        const encoded = store.loadCheckpoint(ownerId, partition);
        let state =
          encoded === undefined
            ? initialOperationApplyState<OperationCheckpointProjection>([])
            : decodeOperationCheckpoint(encoded);
        state = applyOperationIntakeBatch(
          partition,
          state,
          operations.map((operation) => ({ encoded: "", operation })),
          {
            append: (_encoded, snapshot) => {
              const appended = store.appendEnvelope(
                ownerId,
                snapshot,
                actorId,
                now,
              );
              if (appended) storedCount += 1;
              if (storedCount > ownerPartitionOperationLimit)
                throw operationProtocolError(
                  "capacity",
                  "Operation history capacity reached",
                );
            },
            reducer,
          },
        );
        const encodedCheckpoint = encodeOperationCheckpoint(state);
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
        );
        return { frontier: state.frontier, encodedCheckpoint };
      });
    },
  };
};
