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
  applyOperation,
  operationProtocolError,
  type CausalFrontier,
  type Operation,
  type OperationApplyState,
  type OperationPartition,
} from "../shared/operation-core";
import { createOperationStore } from "./operation-store";

interface OperationIntakeResources {
  readonly database: AppDatabase;
  readonly generateId?: IdGenerator;
}
interface OperationIntakeResult {
  readonly frontier: CausalFrontier;
  readonly encodedCheckpoint: string;
}
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

export const createOperationIntake = (resources: OperationIntakeResources) => {
  const store = createOperationStore({
    database: resources.database,
    generateId: resources.generateId ?? createUuidV7,
  });
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
            ? initialState()
            : decodeOperationCheckpoint(encoded);
        for (const operation of operations) {
          if (operation.partition !== partition)
            throw operationProtocolError(
              "invalid",
              "Operation intake scope mismatch",
            );
          const appended = store.appendEnvelope(
            ownerId,
            operation,
            actorId,
            now,
          );
          if (appended) storedCount += 1;
          if (storedCount > MAX_OWNER_PARTITION_OPERATIONS)
            throw operationProtocolError(
              "capacity",
              "Operation history capacity reached",
            );
          state = applyOperation(state, operation, reducer);
        }
        const encodedCheckpoint = encodeOperationCheckpoint(state);
        if (
          new TextEncoder().encode(encodedCheckpoint).byteLength >
          MAX_OPERATION_CHECKPOINT_BYTES
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
