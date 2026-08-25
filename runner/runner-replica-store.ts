import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../shared/auth-model.ts";
import { sha256 } from "../shared/sha256.ts";

import type { AccountExportRecord } from "../shared/account-export.ts";

export type ReplicaRecord = AccountExportRecord;

export interface ReplicaBlobManifestEntry {
  readonly digest: string;
  readonly size: number;
}

export interface ReplicaProgress {
  readonly records: number;
  readonly state: "joining" | "ready";
  readonly tombstones: number;
}

function parsedRecord(payload: string): Record<string, unknown> {
  const value: unknown = JSON.parse(payload);
  if (!isRecord(value)) {
    throw new Error("The replica record payload is invalid");
  }
  return value;
}

export function createRunnerReplicaStore(directory: string) {
  mkdirSync(join(directory, "blobs"), { recursive: true });
  const database = new Database(join(directory, "replica.sqlite"), {
    create: true,
  });
  database.run("PRAGMA journal_mode = WAL");
  database.run(
    "CREATE TABLE IF NOT EXISTS replica_records (entity TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, tombstone INTEGER NOT NULL, PRIMARY KEY (entity, id))",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS replica_manifest (digest TEXT PRIMARY KEY, size INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0)",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS replica_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const state = database.query("SELECT value FROM replica_state WHERE key = ?");
  const setState = database.query(
    "INSERT INTO replica_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const count = (sql: string): number =>
    database.query<{ count: number }, []>(sql).all()[0]?.count ?? 0;
  const progress = (): ReplicaProgress => {
    const records = count("SELECT COUNT(*) AS count FROM replica_records");
    const tombstones = count(
      "SELECT COUNT(*) AS count FROM replica_records WHERE tombstone = 1",
    );
    const missing = count(
      "SELECT COUNT(*) AS count FROM replica_manifest WHERE complete = 0",
    );
    const hasFrontier = state.get("frontier") !== null;
    const hasManifest = state.get("manifest") !== null;
    return {
      records,
      state: hasFrontier && hasManifest && missing === 0 ? "ready" : "joining",
      tombstones,
    };
  };
  return {
    begin: ({
      availableBytes,
      requiredBytes,
    }: {
      availableBytes: number;
      requiredBytes: number;
    }) => {
      if (requiredBytes > availableBytes)
        throw new Error("Insufficient replica capacity");
      setState.run("joining", "true");
    },
    applyRecords: (records: readonly ReplicaRecord[]) => {
      const insert = database.query(
        "INSERT INTO replica_records (entity, id, payload, tombstone) VALUES (?, ?, ?, ?) ON CONFLICT (entity, id) DO UPDATE SET payload = excluded.payload, tombstone = excluded.tombstone",
      );
      database.transaction(() => {
        for (const record of records)
          insert.run(
            record.entity,
            record.id,
            record.payload,
            record.tombstone ? 1 : 0,
          );
      })();
    },
    setFrontier: (frontier: string) => setState.run("frontier", frontier),
    setManifest: (entries: readonly ReplicaBlobManifestEntry[]) => {
      database.transaction(() => {
        const expected = new Set(entries.map(({ digest }) => digest));
        const existing = database
          .query<{ digest: string }, []>("SELECT digest FROM replica_manifest")
          .all();
        for (const { digest } of existing) {
          if (!expected.has(digest)) {
            database
              .query("DELETE FROM replica_manifest WHERE digest = ?")
              .run(digest);
          }
        }
        const insert = database.query(
          "INSERT INTO replica_manifest (digest, size) VALUES (?, ?) ON CONFLICT (digest) DO UPDATE SET size = excluded.size",
        );
        for (const entry of entries) insert.run(entry.digest, entry.size);
        setState.run("manifest", "complete");
      })();
    },
    missingBlobs: (): readonly ReplicaBlobManifestEntry[] =>
      database
        .query<ReplicaBlobManifestEntry, []>(
          "SELECT digest, size FROM replica_manifest WHERE complete = 0 ORDER BY digest",
        )
        .all(),
    installBlob: async (path: string) => {
      const bytes = await Bun.file(path).bytes();
      const digest = sha256(bytes);
      const expected = database
        .query<{ size: number }, [string]>(
          "SELECT size FROM replica_manifest WHERE digest = ?",
        )
        .get(digest);
      if (expected?.size !== bytes.byteLength)
        throw new Error("Blob checksum is not in the replica manifest");
      renameSync(path, join(directory, "blobs", digest));
      database
        .query("UPDATE replica_manifest SET complete = 1 WHERE digest = ?")
        .run(digest);
    },
    readView: (entity: string, limit: number, sessionId?: string) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Replica view limit must be between 1 and 100");
      }
      if (progress().state !== "ready") {
        throw new Error("The runner replica is still joining");
      }
      const stored = database
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM replica_records WHERE entity = ? AND tombstone = 0 ORDER BY id",
        )
        .all(entity)
        .map(({ payload }) => parsedRecord(payload))
        .filter(
          (record) =>
            sessionId === undefined || record["session_id"] === sessionId,
        );
      return {
        complete: true as const,
        partial: true as const,
        records: stored.slice(0, limit),
      };
    },
    progress,
    close: () => {
      database.close();
    },
  };
}
