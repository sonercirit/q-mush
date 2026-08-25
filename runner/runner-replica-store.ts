import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { validActiveViewLimit } from "../shared/active-view.ts";
import { isRecord } from "../shared/auth-model.ts";
import { isSha256Digest } from "../shared/digest.ts";
import { sha256 } from "../shared/sha256.ts";

import type { AccountExportRecord } from "../shared/account-export.ts";
import type { AccountExportRetryProgress } from "./runner-account-export-client.ts";

export type ReplicaRecord = AccountExportRecord;

export interface ReplicaBlobManifestEntry {
  readonly digest: string;
  readonly size: number;
}

export interface ReplicaProgress {
  readonly elapsedMilliseconds?: number;
  readonly previousRevision?: string;
  readonly records: number;
  readonly restartCount?: number;
  readonly revision?: string;
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

function parsedRetry(value: string | undefined): Partial<ReplicaProgress> {
  if (value === undefined) return {};
  const parsed: unknown = JSON.parse(value);
  const retry = isRecord(parsed) ? parsed : undefined;
  if (retry === undefined) return {};
  const elapsedMilliseconds = retry["elapsedMilliseconds"];
  const previousRevision = retry["previousRevision"];
  const restartCount = retry["restartCount"];
  const revision = retry["revision"];
  if (
    typeof elapsedMilliseconds !== "number" ||
    typeof previousRevision !== "string" ||
    typeof restartCount !== "number" ||
    typeof revision !== "string"
  )
    throw new Error("Invalid persisted replica retry progress");
  return { elapsedMilliseconds, previousRevision, restartCount, revision };
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
  const state = database.query<{ value: string }, [string]>(
    "SELECT value FROM replica_state WHERE key = ?",
  );
  const setState = database.query(
    "INSERT INTO replica_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const count = (sql: string): number =>
    database.query<{ count: number }, []>(sql).all()[0]?.count ?? 0;
  const verifyBlobs = (): number => {
    const entries = database
      .query<ReplicaBlobManifestEntry, []>(
        "SELECT digest, size FROM replica_manifest WHERE complete = 1",
      )
      .all();
    let invalid = 0;
    for (const entry of entries) {
      const path = join(directory, "blobs", entry.digest);
      const valid =
        existsSync(path) &&
        Bun.file(path).size === entry.size &&
        sha256(readFileSync(path)) === entry.digest;
      if (!valid) {
        database
          .query("UPDATE replica_manifest SET complete = 0 WHERE digest = ?")
          .run(entry.digest);
        invalid += 1;
      }
    }
    return invalid;
  };
  let blobsVerified = false;
  const progress = (): ReplicaProgress => {
    if (!blobsVerified) {
      verifyBlobs();
      blobsVerified = true;
    }
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
      ...parsedRetry(state.get("retry")?.value),
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
    setFrontier: (frontier: string, verifiedFrontier: string) => {
      if (frontier !== verifiedFrontier)
        throw new Error("Replica frontier checksum is invalid");
      setState.run("frontier", frontier);
    },
    setManifest: (entries: readonly ReplicaBlobManifestEntry[]) => {
      blobsVerified = false;
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
          "INSERT INTO replica_manifest (digest, size, complete) VALUES (?, ?, 0) ON CONFLICT (digest) DO UPDATE SET size = excluded.size, complete = CASE WHEN replica_manifest.size = excluded.size THEN replica_manifest.complete ELSE 0 END",
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
      blobsVerified = false;
      renameSync(path, join(directory, "blobs", digest));
      database
        .query("UPDATE replica_manifest SET complete = 1 WHERE digest = ?")
        .run(digest);
    },
    readBlob: (digest: string) => {
      if (!isSha256Digest(digest) || progress().state !== "ready") {
        throw new Error("Replica blob is unavailable");
      }
      const entry = database
        .query<{ complete: number; size: number }, [string]>(
          "SELECT complete, size FROM replica_manifest WHERE digest = ?",
        )
        .get(digest);
      const file = Bun.file(join(directory, "blobs", digest));
      const bytes = readFileSync(join(directory, "blobs", digest));
      if (
        entry?.complete !== 1 ||
        bytes.byteLength !== entry.size ||
        sha256(bytes) !== digest
      ) {
        database
          .query("UPDATE replica_manifest SET complete = 0 WHERE digest = ?")
          .run(digest);
        throw new Error("Replica blob is unavailable");
      }
      return file;
    },
    readView: (entity: string, limit: number, sessionId?: string) => {
      if (!validActiveViewLimit(limit)) {
        throw new Error("Replica view limit must be between 1 and 100");
      }
      if (progress().state !== "ready") {
        throw new Error("The runner replica is still joining");
      }
      const rows =
        sessionId === undefined
          ? database
              .query<{ payload: string }, [string, number]>(
                "SELECT payload FROM replica_records WHERE entity = ? AND tombstone = 0 ORDER BY id LIMIT CAST(? AS INTEGER)",
              )
              .all(entity, limit + 1)
          : database
              .query<{ payload: string }, [string, string, number]>(
                "SELECT payload FROM replica_records WHERE entity = ? AND tombstone = 0 AND json_extract(payload, '$.session_id') = ? ORDER BY id LIMIT CAST(? AS INTEGER)",
              )
              .all(entity, sessionId, limit + 1);
      const selectedRecords = rows
        .slice(0, limit)
        .map(({ payload }) => parsedRecord(payload));
      return {
        complete: rows.length <= limit,
        partial: true as const,
        records: selectedRecords,
      };
    },
    recordRetry: (retry: AccountExportRetryProgress) =>
      setState.run("retry", JSON.stringify(retry)),
    progress,
    close: () => {
      database.close();
    },
  };
}
