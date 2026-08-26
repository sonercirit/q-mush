import { and, eq, or } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit";
import type { AppDatabase } from "../shared/database";
import {
  operationCheckpoints,
  operationEnvelopes,
} from "../shared/database/schema";
import { createUuidV7, type IdGenerator } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
  encodeOperationEnvelope,
  type OperationCheckpointProjection,
} from "../shared/operation-checkpoint";
import {
  applyOperation,
  operationFingerprint,
  type CausalFrontier,
  type Operation,
  type OperationApplyState,
  type OperationPartition,
} from "../shared/operation-core";

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
  const generateId = resources.generateId ?? createUuidV7;
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
      if (operations.length > 512)
        throw new Error("Operation intake batch is too large");
      return resources.database.transaction((transaction) => {
        const checkpointScope = and(
          eq(operationCheckpoints.userId, ownerId),
          eq(operationCheckpoints.partition, partition),
          eq(operationCheckpoints.isDeleted, false),
        );
        const existingCheckpoint = transaction
          .select({
            id: operationCheckpoints.id,
            encoded: operationCheckpoints.encodedCheckpoint,
          })
          .from(operationCheckpoints)
          .where(checkpointScope)
          .get();
        let state =
          existingCheckpoint === undefined
            ? initialState()
            : decodeOperationCheckpoint(existingCheckpoint.encoded);
        for (const operation of operations) {
          if (operation.partition !== partition)
            throw new Error("Operation intake scope mismatch");
          const fingerprint = operationFingerprint(operation);
          const identities = transaction
            .select({ fingerprint: operationEnvelopes.fingerprint })
            .from(operationEnvelopes)
            .where(
              and(
                eq(operationEnvelopes.userId, ownerId),
                eq(operationEnvelopes.isDeleted, false),
                or(
                  eq(operationEnvelopes.operationId, operation.operationId),
                  and(
                    eq(operationEnvelopes.writerId, operation.writerId),
                    eq(
                      operationEnvelopes.sequence,
                      operation.sequence.toString(),
                    ),
                  ),
                ),
              ),
            )
            .all();
          if (identities.some((item) => item.fingerprint !== fingerprint))
            throw new Error("Operation identity equivocation");
          if (identities.length === 0)
            transaction
              .insert(operationEnvelopes)
              .values({
                id: generateId(now),
                userId: ownerId,
                partition,
                writerId: operation.writerId,
                sequence: operation.sequence.toString(),
                operationId: operation.operationId,
                fingerprint,
                encodedEnvelope: encodeOperationEnvelope(operation),
                ...createdAuditFields(actorId, now),
              })
              .run();
          state = applyOperation(state, operation, reducer);
        }
        const encodedCheckpoint = encodeOperationCheckpoint(state);
        if (existingCheckpoint === undefined)
          transaction
            .insert(operationCheckpoints)
            .values({
              id: generateId(now),
              userId: ownerId,
              partition,
              encodedCheckpoint,
              ...createdAuditFields(actorId, now),
            })
            .run();
        else
          transaction
            .update(operationCheckpoints)
            .set({ encodedCheckpoint, ...updatedAuditFields(actorId, now) })
            .where(eq(operationCheckpoints.id, existingCheckpoint.id))
            .run();
        return { frontier: state.frontier, encodedCheckpoint };
      });
    },
  };
};
