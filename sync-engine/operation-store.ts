import { and, asc, count, eq, gt, notInArray, or } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit";
import type { AppDatabase } from "../shared/database";
import {
  operationCheckpoints,
  operationEnvelopes,
} from "../shared/database/schema";
import { createUuidV7, type IdGenerator } from "../shared/ids";
import { encodeOperationEnvelope } from "../shared/operation-checkpoint";
import {
  operationFingerprint,
  operationProtocolError,
  operationSequenceOrder,
  type Operation,
  type OperationPartition,
} from "../shared/operation-core";

interface OperationStoreResources {
  readonly database: AppDatabase;
  readonly generateId?: IdGenerator;
}

export interface EncodedOperationEnvelopePage {
  readonly envelopes: readonly string[];
  readonly hasMore: boolean;
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

type EnvelopeQueryParameters = readonly [
  ownerId: string,
  partition: OperationPartition,
  frontier: Readonly<Record<string, bigint>>,
  limit: number,
];
function buildOperationEnvelopeQuery(
  database: AppDatabase,
  ...[ownerId, partition, frontier, limit]: EnvelopeQueryParameters
) {
  const writers = Object.keys(frontier);
  const afterFrontier = writers.map((writerId) =>
    and(
      eq(operationEnvelopes.writerId, writerId),
      gt(
        operationEnvelopes.sequenceOrder,
        operationSequenceOrder(frontier[writerId] ?? 0n),
      ),
    ),
  );
  const range =
    writers.length === 0
      ? activeEnvelopeScope(ownerId, partition)
      : and(
          activeEnvelopeScope(ownerId, partition),
          or(
            notInArray(operationEnvelopes.writerId, writers),
            ...afterFrontier,
          ),
        );
  return database
    .select({ encoded: operationEnvelopes.encodedEnvelope })
    .from(operationEnvelopes)
    .where(range)
    .orderBy(
      asc(operationEnvelopes.writerId),
      asc(operationEnvelopes.sequenceOrder),
    )
    .limit(limit + 1);
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
              eq(operationEnvelopes.partition, operation.partition),
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
          throw operationProtocolError(
            "conflict",
            "Operation identity equivocation",
          );
        if (existing.length > 0) return false;
        transaction
          .insert(operationEnvelopes)
          .values({
            id: generateId(now),
            userId: ownerId,
            partition: operation.partition,
            writerId: operation.writerId,
            sequence: operation.sequence.toString(),
            sequenceOrder: operationSequenceOrder(operation.sequence),
            operationId: operation.operationId,
            fingerprint,
            encodedEnvelope: encodeOperationEnvelope(operation),
            ...createdAuditFields(actorId, now),
          })
          .run();
        return true;
      });
    },
    readEncodedEnvelopes(
      ...parameters: EnvelopeQueryParameters
    ): EncodedOperationEnvelopePage {
      const limit = parameters[3];
      const rows = buildOperationEnvelopeQuery(database, ...parameters).all();
      const envelopes = rows.slice(0, limit).map(({ encoded }) => encoded);
      return { envelopes, hasMore: rows.length > limit };
    },
    countEnvelopes(ownerId: string, partition: OperationPartition): number {
      return (
        database
          .select({ value: count() })
          .from(operationEnvelopes)
          .where(activeEnvelopeScope(ownerId, partition))
          .get()?.value ?? 0
      );
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
      database.transaction((transaction) => {
        const existing = transaction.query.operationCheckpoints
          .findFirst({
            columns: { id: true },
            where: activeCheckpointScope(ownerId, partition),
          })
          .sync();
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
