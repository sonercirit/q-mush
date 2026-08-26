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
  decodeOperationEnvelope,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import {
  operationFingerprint,
  type CausalFrontier,
  type Operation,
  type OperationPartition,
} from "../shared/operation-core";

interface OperationStoreResources {
  readonly database: AppDatabase;
  readonly generateId?: IdGenerator;
}

function activeEnvelopeScope(ownerId: string, partition: OperationPartition) {
  return and(
    eq(operationEnvelopes.userId, ownerId),
    eq(operationEnvelopes.partition, partition),
    eq(operationEnvelopes.isDeleted, false),
  );
}
function activeCheckpointScope(ownerId: string, partition: OperationPartition) {
  return and(
    eq(operationCheckpoints.userId, ownerId),
    eq(operationCheckpoints.partition, partition),
    eq(operationCheckpoints.isDeleted, false),
  );
}

export function createOperationStore(resources: OperationStoreResources) {
  const database = resources.database;
  const generateId = resources.generateId ?? createUuidV7;
  return {
    appendEnvelope(
      ownerId: string,
      operation: Operation,
      actorId: string,
      now: number,
    ): boolean {
      const fingerprint = operationFingerprint(operation);
      return database.transaction((transaction) => {
        const existing = transaction
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
        if (existing.some((item) => item.fingerprint !== fingerprint))
          throw new Error("Operation identity equivocation");
        if (existing.length > 0) return false;
        transaction
          .insert(operationEnvelopes)
          .values({
            id: generateId(now),
            userId: ownerId,
            partition: operation.partition,
            writerId: operation.writerId,
            sequence: operation.sequence.toString(),
            operationId: operation.operationId,
            fingerprint,
            encodedEnvelope: encodeOperationEnvelope(operation),
            ...createdAuditFields(actorId, now),
          })
          .run();
        return true;
      });
    },
    readEnvelopeRange(
      ownerId: string,
      partition: OperationPartition,
      frontier: CausalFrontier,
      limit: number,
    ): readonly Operation[] {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("Envelope range limit must be positive");
      return database
        .select({ encodedEnvelope: operationEnvelopes.encodedEnvelope })
        .from(operationEnvelopes)
        .where(activeEnvelopeScope(ownerId, partition))
        .all()
        .map((row) => decodeOperationEnvelope(row.encodedEnvelope))
        .filter(
          (operation) =>
            operation.sequence > (frontier[operation.writerId] ?? 0n),
        )
        .sort(
          (left, right) =>
            left.writerId.localeCompare(right.writerId) ||
            (left.sequence < right.sequence
              ? -1
              : left.sequence > right.sequence
                ? 1
                : 0),
        )
        .slice(0, limit);
    },
    loadCheckpoint(
      ownerId: string,
      partition: OperationPartition,
    ): string | undefined {
      return database
        .select({ encoded: operationCheckpoints.encodedCheckpoint })
        .from(operationCheckpoints)
        .where(activeCheckpointScope(ownerId, partition))
        .get()?.encoded;
    },
    storeCheckpoint(
      ownerId: string,
      partition: OperationPartition,
      encodedCheckpoint: string,
      actorId: string,
      now: number,
    ): void {
      decodeOperationCheckpoint(encodedCheckpoint);
      database.transaction((transaction) => {
        const existing = transaction.query.operationCheckpoints.findFirst({
          columns: { id: true },
          where: activeCheckpointScope(ownerId, partition),
        }).sync();
        if (existing === undefined) {
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
          return;
        }
        transaction
          .update(operationCheckpoints)
          .set({
            encodedCheckpoint,
            ...updatedAuditFields(actorId, now),
          })
          .where(eq(operationCheckpoints.id, existing.id))
          .run();
      });
    },
  };
}
