import type { Database } from "bun:sqlite";

import type {
  Operation,
  OperationPartition,
} from "../shared/operation-core.ts";

export type OperationReplicaSource = "local" | "remote";

export const createRunnerOperationLog = (database: Database) => {
  database.run(
    "CREATE TABLE IF NOT EXISTS operation_envelopes (owner_id TEXT NOT NULL, partition TEXT NOT NULL, operation_id TEXT NOT NULL, writer_id TEXT NOT NULL, sequence TEXT NOT NULL, encoded TEXT NOT NULL, verification_state TEXT NOT NULL, source TEXT NOT NULL, rejection_reason TEXT, outbox_pending INTEGER NOT NULL, PRIMARY KEY (owner_id, partition, operation_id), UNIQUE (owner_id, partition, writer_id, sequence))",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS operation_checkpoints (owner_id TEXT NOT NULL, partition TEXT NOT NULL, encoded TEXT NOT NULL, PRIMARY KEY (owner_id, partition))",
  );
  const append = database.query(
    "INSERT INTO operation_envelopes (owner_id, partition, operation_id, writer_id, sequence, encoded, verification_state, source, rejection_reason, outbox_pending) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, NULL, ?) ON CONFLICT DO NOTHING",
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
      const query = database.query<{ encoded: string }, [string, string]>(
        "SELECT encoded FROM operation_checkpoints WHERE owner_id = ? AND partition = ?",
      );
      return query.get(ownerId, partition)?.encoded;
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
    ) {
      const query = database.query(
        "INSERT INTO operation_envelopes (owner_id, partition, operation_id, writer_id, sequence, encoded, verification_state, source, rejection_reason, outbox_pending) VALUES (?, ?, ?, '', '', ?, 'rejected', 'remote', ?, 0)",
      );
      query.run(ownerId, partition, crypto.randomUUID(), encoded, reason);
    },
    pending(ownerId: string, partition: OperationPartition) {
      return database
        .query<{ encoded: string }, [string, string]>(
          "SELECT encoded FROM operation_envelopes WHERE owner_id = ? AND partition = ? AND outbox_pending = 1 ORDER BY rowid LIMIT 512",
        )
        .all(ownerId, partition)
        .map(({ encoded }) => encoded);
    },
    acknowledge(
      ownerId: string,
      partition: OperationPartition,
      envelopes: readonly string[],
    ) {
      const update = database.query(
        "UPDATE operation_envelopes SET outbox_pending = 0 WHERE owner_id = ? AND partition = ? AND encoded = ?",
      );
      database.transaction(() => {
        for (const encoded of envelopes)
          update.run(ownerId, partition, encoded);
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
          [string, string]
        >(
          "SELECT encoded, rejection_reason AS rejectionReason, source, verification_state AS verificationState FROM operation_envelopes WHERE owner_id = ? AND partition = ? ORDER BY rowid",
        )
        .all(ownerId, partition);
    },
  };
};
