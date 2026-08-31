import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { decodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type {
  Operation,
  OperationPartition,
} from "../shared/operation-core.ts";
import { operationFingerprint } from "../shared/operation-core.ts";

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

const operationIdentity = (
  ownerId: string,
  operation: Operation,
): [string, OperationPartition, string, string, string] => [
  ownerId,
  operation.partition,
  operation.operationId,
  operation.writerId,
  operation.sequence.toString(),
];

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
  database.run(
    "CREATE TABLE IF NOT EXISTS operation_outbox_stalls (owner_id TEXT NOT NULL, partition TEXT NOT NULL, operation_id TEXT NOT NULL, writer_id TEXT NOT NULL, sequence TEXT NOT NULL, encoded TEXT NOT NULL, rejection_reason TEXT NOT NULL, PRIMARY KEY (owner_id, partition, operation_id), UNIQUE (owner_id, partition, writer_id, sequence))",
  );
  const findIdentity = database.query<
    { encoded: string },
    [string, OperationPartition, string, string, string]
  >(
    "SELECT encoded FROM operation_envelopes WHERE owner_id = ? AND partition = ? AND (operation_id = ? OR (writer_id = ? AND sequence = ?))",
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
  const outboxStalls = database.query<
    {
      operationId: string;
      queuedBehind: number;
      reason: string;
      writerId: string;
    },
    [string, OperationPartition]
  >(
    "SELECT stalls.operation_id AS operationId, stalls.writer_id AS writerId, stalls.rejection_reason AS reason, (SELECT count(*) FROM operation_envelopes AS queued WHERE queued.owner_id = stalls.owner_id AND queued.partition = stalls.partition AND queued.writer_id = stalls.writer_id AND queued.outbox_pending = 1 AND queued.rowid > envelopes.rowid) AS queuedBehind FROM operation_outbox_stalls AS stalls JOIN operation_envelopes AS envelopes ON envelopes.owner_id = stalls.owner_id AND envelopes.partition = stalls.partition AND envelopes.operation_id = stalls.operation_id WHERE stalls.owner_id = ? AND stalls.partition = ? ORDER BY envelopes.rowid",
  );
  const pendingOutbox = database.query<
    { encoded: string },
    [string, OperationPartition]
  >(
    "SELECT encoded FROM operation_envelopes WHERE owner_id = ? AND partition = ? AND outbox_pending = 1 ORDER BY rowid LIMIT 512",
  );
  const stallOutbox = database.query(
    "INSERT INTO operation_outbox_stalls (owner_id, partition, operation_id, writer_id, sequence, encoded, rejection_reason) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, partition, operation_id) DO UPDATE SET rejection_reason = excluded.rejection_reason",
  );
  const append = database.query(
    "INSERT INTO operation_envelopes (owner_id, partition, operation_id, writer_id, sequence, encoded, verification_state, source, rejection_reason, outbox_pending) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, ?) ON CONFLICT DO NOTHING",
  );
  const quarantine = database.query(
    "INSERT INTO operation_quarantines (owner_id, partition, operation_id, writer_id, sequence, encoded, rejection_reason) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  return {
    classifyIdentity(
      ownerId: string,
      operation: Operation,
    ): "absent" | "duplicate" | "conflict" {
      const rows = findIdentity.all(...operationIdentity(ownerId, operation));
      if (rows.length === 0) return "absent";
      const fingerprint = operationFingerprint(operation);
      return rows.every(
        ({ encoded }) =>
          operationFingerprint(decodeOperationEnvelope(encoded)) ===
          fingerprint,
      )
        ? "duplicate"
        : "conflict";
    },
    append(
      ownerId: string,
      operation: Operation,
      encoded: string,
      source: OperationReplicaSource,
    ) {
      append.run(
        ...operationIdentity(ownerId, operation),
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
      const clearStall = database.query(
        "DELETE FROM operation_outbox_stalls WHERE owner_id = ? AND partition = ? AND operation_id = ?",
      );
      const update = database.query(
        "UPDATE operation_envelopes SET outbox_pending = 0 WHERE owner_id = ? AND partition = ? AND operation_id = ?",
      );
      database.transaction(() => {
        for (const encoded of envelopes) {
          const operation = decodeOperationEnvelope(encoded);
          update.run(ownerId, partition, operation.operationId);
          clearStall.run(ownerId, partition, operation.operationId);
        }
      })();
    },
    stallOutbox(
      ownerId: string,
      partition: OperationPartition,
      encoded: string,
      reason: string,
    ) {
      const operation = decodeOperationEnvelope(encoded);
      if (operation.partition !== partition)
        throw new Error("Outbox stall partition mismatch");
      stallOutbox.run(
        ...operationIdentity(ownerId, operation),
        encoded,
        reason,
      );
    },
    outboxStalls(ownerId: string, partition: OperationPartition) {
      return outboxStalls.all(ownerId, partition);
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
