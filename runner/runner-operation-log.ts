import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { decodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type {
  Operation,
  OperationPartition,
} from "../shared/operation-core.ts";

export type OperationReplicaSource = "local" | "remote";

interface QuarantineIdentity {
  readonly operationId: string;
  readonly sequence: bigint;
  readonly writerId: string;
}

const undecodableIdentity = (encoded: string): QuarantineIdentity => {
  const digest = createHash("sha256").update(encoded).digest("hex");
  return {
    operationId: `undecodable:${digest}`,
    writerId: `undecodable:${digest}`,
    sequence: 0n,
  };
};

export const createRunnerOperationLog = (database: Database) => {
  database.run(
    "CREATE TABLE IF NOT EXISTS operation_envelopes (owner_id TEXT NOT NULL, partition TEXT NOT NULL, operation_id TEXT NOT NULL, writer_id TEXT NOT NULL, sequence TEXT NOT NULL, encoded TEXT NOT NULL, verification_state TEXT NOT NULL, source TEXT NOT NULL, rejection_reason TEXT, outbox_pending INTEGER NOT NULL, PRIMARY KEY (owner_id, partition, operation_id), UNIQUE (owner_id, partition, writer_id, sequence))",
  );
  database.run(
    "UPDATE operation_envelopes SET verification_state = 'accepted' WHERE verification_state = 'verified'",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS operation_checkpoints (owner_id TEXT NOT NULL, partition TEXT NOT NULL, encoded TEXT NOT NULL, PRIMARY KEY (owner_id, partition))",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS operation_quarantines (owner_id TEXT NOT NULL, partition TEXT NOT NULL, operation_id TEXT NOT NULL, writer_id TEXT NOT NULL, sequence TEXT NOT NULL, encoded TEXT NOT NULL, rejection_reason TEXT NOT NULL, PRIMARY KEY (owner_id, partition, operation_id), UNIQUE (owner_id, partition, writer_id, sequence))",
  );
  const loadCheckpoint = database.query<
    { encoded: string },
    [string, OperationPartition]
  >(
    "SELECT encoded FROM operation_checkpoints WHERE owner_id = ? AND partition = ?",
  );
  const findStall = database.query<
    { found: number },
    [string, OperationPartition]
  >(
    "SELECT 1 AS found FROM operation_quarantines WHERE owner_id = ? AND partition = ? LIMIT 1",
  );
  const pendingOutbox = database.query<
    { encoded: string },
    [string, OperationPartition]
  >(
    "SELECT encoded FROM operation_envelopes WHERE owner_id = ? AND partition = ? AND outbox_pending = 1 ORDER BY rowid LIMIT 512",
  );
  const append = database.query(
    "INSERT INTO operation_envelopes (owner_id, partition, operation_id, writer_id, sequence, encoded, verification_state, source, rejection_reason, outbox_pending) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, ?) ON CONFLICT DO NOTHING",
  );
  const quarantine = database.query(
    "INSERT INTO operation_quarantines (owner_id, partition, operation_id, writer_id, sequence, encoded, rejection_reason) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  return {
    append(
      ownerId: string,
      operation: Operation,
      encoded: string,
      source: OperationReplicaSource,
    ) {
      append.run(
        ownerId,
        operation.partition,
        operation.operationId,
        operation.writerId,
        operation.sequence.toString(),
        encoded,
        source,
        source === "local" ? 1 : 0,
      );
    },
    checkpoint(ownerId: string, partition: OperationPartition) {
      return loadCheckpoint.get(ownerId, partition)?.encoded;
    },
    storeCheckpoint(
      ownerId: string,
      partition: OperationPartition,
      encoded: string,
    ) {
      database
        .query(
          "INSERT INTO operation_checkpoints (owner_id, partition, encoded) VALUES (?, ?, ?) ON CONFLICT (owner_id, partition) DO UPDATE SET encoded = excluded.encoded",
        )
        .run(ownerId, partition, encoded);
    },
    quarantine(
      ownerId: string,
      partition: OperationPartition,
      encoded: string,
      reason: string,
      identity?: QuarantineIdentity,
    ) {
      const key = identity ?? undecodableIdentity(encoded);
      quarantine.run(
        ownerId,
        partition,
        key.operationId,
        key.writerId,
        key.sequence.toString(),
        encoded,
        reason,
      );
    },
    stalled(ownerId: string, partition: OperationPartition): boolean {
      return findStall.get(ownerId, partition) !== null;
    },
    pending(ownerId: string, partition: OperationPartition) {
      return pendingOutbox
        .all(ownerId, partition)
        .map(({ encoded }) => encoded);
    },
    acknowledge(
      ownerId: string,
      partition: OperationPartition,
      envelopes: readonly string[],
    ) {
      const update = database.query(
        "UPDATE operation_envelopes SET outbox_pending = 0 WHERE owner_id = ? AND partition = ? AND operation_id = ?",
      );
      database.transaction(() => {
        for (const encoded of envelopes) {
          const operation = decodeOperationEnvelope(encoded);
          update.run(ownerId, partition, operation.operationId);
        }
      })();
    },
    rejectOutbox(
      ownerId: string,
      partition: OperationPartition,
      envelopes: readonly string[],
      reason: string,
    ) {
      const update = database.query(
        "UPDATE operation_envelopes SET outbox_pending = 0, verification_state = 'rejected', rejection_reason = ? WHERE owner_id = ? AND partition = ? AND operation_id = ? AND source = 'local'",
      );
      database.transaction(() => {
        for (const encoded of envelopes)
          update.run(
            reason,
            ownerId,
            partition,
            decodeOperationEnvelope(encoded).operationId,
          );
      })();
    },
    inspect(ownerId: string, partition: OperationPartition) {
      return database
        .query<
          {
            encoded: string;
            rejectionReason: string | null;
            source: string;
            verificationState: string;
          },
          [string, string, string, string]
        >(
          "SELECT encoded, rejection_reason AS rejectionReason, source, verification_state AS verificationState FROM operation_envelopes WHERE owner_id = ? AND partition = ? UNION ALL SELECT encoded, rejection_reason, 'remote', 'rejected' FROM operation_quarantines WHERE owner_id = ? AND partition = ?",
        )
        .all(ownerId, partition, ownerId, partition);
    },
  };
};
