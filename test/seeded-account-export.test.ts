import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { catchUpRunnerReplica } from "../runner/runner-replica-catch-up.ts";
import {
  ACCOUNT_EXPORT_ENTITIES,
  completeAccountExportInventory,
  type AccountExportBlob,
  type AccountExportInventory,
  type AccountExportRecord,
} from "../shared/account-export.ts";
import { isRecord } from "../shared/auth-model.ts";
import { createDatabase } from "../shared/database.ts";
import { exportAccountPage } from "../sync-engine/account-export.ts";

function exportAccount(
  database: ReturnType<typeof createDatabase>,
): AccountExportInventory & { readonly blobs: readonly AccountExportBlob[] } {
  const records: AccountExportRecord[] = [];
  const blobs = new Map<string, AccountExportBlob>();
  let cursor: string | undefined;
  let done = false;
  while (!done) {
    const page = exportAccountPage(database, USER_ID, cursor);
    records.push(...page.records);
    for (const blob of page.blobs) blobs.set(blob.digest, blob);
    cursor = page.nextCursor;
    done = page.done;
  }
  const entries: AccountExportBlob[] = [...blobs.values()];
  return {
    ...completeAccountExportInventory(
      records,
      entries.map(({ digest, size }) => ({ digest, size })),
    ),
    blobs: entries,
  };
}

const USER_ID = "seed-user";
const requiredText: Readonly<Record<string, string>> = {
  api_format: "responses",
  architecture: "x64",
  content: "seed-content",
  cost_basis: "reported",
  email: "seed@example.test",
  execution_environment: "bare_metal",
  kind: "follow_up",
  machine_fingerprint: "machine",
  model: "seed-model",
  name: "seed-name",
  normalized_name: "seed-name",
  platform: "linux",
  provider: "openai",
  role: "user",
  source: "api_key",
  status: "idle",
  token: "seed-token",
  working_directory: "/seed",
};

function parsedPayload(payload: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payload);
  if (!isRecord(parsed)) throw new Error("invalid exported payload");
  return parsed;
}

function seedTable(database: Database, table: string, ordinal: number): void {
  const columns = database
    .query<
      {
        name: string;
        notnull: number;
        pk: number;
        type: string;
        dflt_value: string | null;
      },
      [string]
    >("SELECT * FROM pragma_table_info(?)")
    .all(table);
  const values = columns.flatMap((column) => {
    if (column.name === "id")
      return [
        [
          column.name,
          table === "users" ? USER_ID : `${table}-${String(ordinal)}`,
        ] as const,
      ];
    if (column.name === "user_id") return [[column.name, USER_ID] as const];
    if (column.name === "session_id")
      return [[column.name, "agent_sessions-1"] as const];
    if (column.name === "runner_id")
      return [[column.name, `runners-${String(ordinal)}`] as const];
    if (column.name === "images" && table === "agent_messages") {
      const data = Buffer.from("seed attachment bytes").toString("base64");
      return [[column.name, JSON.stringify([{ data }])] as const];
    }
    if (column.notnull === 0 || column.dflt_value !== null) return [];
    const value =
      requiredText[column.name] ??
      (column.type.includes("INT") || column.type.includes("REAL")
        ? 1
        : `${column.name}-${String(ordinal)}`);
    return [[column.name, value] as const];
  });
  const names = values.map(([name]) => `"${name}"`).join(",");
  const placeholders = values.map(() => "?").join(",");
  database
    .query(`INSERT INTO "${table}" (${names}) VALUES (${placeholders})`)
    .run(...values.map(([, value]) => value));
}

test("a seeded engine export catches up byte-completely across executors", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-export-"));
  const engine = createDatabase(join(root, "engine.sqlite"));
  engine.$client.run("PRAGMA foreign_keys = OFF");
  engine.$client.run("PRAGMA ignore_check_constraints = ON");
  try {
    seedTable(engine.$client, "users", 1);
    for (const entity of ACCOUNT_EXPORT_ENTITIES.filter(
      (name) => name !== "users",
    )) {
      seedTable(engine.$client, entity, 1);
    }
    seedTable(engine.$client, "runners", 2);
    seedTable(engine.$client, "agent_sessions", 2);
    engine.$client.run("UPDATE prompts SET is_deleted = 1");
    const exported = exportAccount(engine);
    const expectedEntityCounts = Object.fromEntries(
      ACCOUNT_EXPORT_ENTITIES.map((entity) => [
        entity,
        entity === "agent_sessions" || entity === "runners" ? 2 : 1,
      ]),
    );
    expect(exported.entityCounts).toEqual(expectedEntityCounts);
    const expectedPublicColumns = {
      provider_credentials: [
        "api_format",
        "created_at",
        "created_by_id",
        "id",
        "is_default",
        "is_deleted",
        "is_global",
        "label",
        "provider",
        "provider_account_id",
        "requires_reauthentication",
        "source",
        "updated_at",
        "updated_by_id",
        "user_id",
      ],
      users: [
        "created_at",
        "created_by_id",
        "email",
        "id",
        "is_deleted",
        "name",
        "updated_at",
        "updated_by_id",
      ],
    } as const;
    for (const [entity, expectedColumns] of Object.entries(
      expectedPublicColumns,
    )) {
      const payload = exported.records.find(
        (record) => record.entity === entity,
      );
      expect(
        Object.keys(parsedPayload(payload?.payload ?? "{}")).sort(),
      ).toEqual(expectedColumns);
    }
    const expectedRunnerColumns = engine.$client
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('runners')",
      )
      .all()
      .map(({ name }) => name)
      .filter(
        (name) =>
          ![
            "setup_token_hash",
            "setup_token_expires_at",
            "token_digest",
            "token_hash",
            "is_global",
          ].includes(name),
      )
      .sort();
    const runnerPayloads = exported.records
      .filter(({ entity }) => entity === "runners")
      .map(({ payload }) => Object.keys(parsedPayload(payload)).sort());
    expect(runnerPayloads).toEqual([
      expectedRunnerColumns,
      expectedRunnerColumns,
    ]);
    const replicaDirectory = join(root, "replica");
    await catchUpRunnerReplica(
      replicaDirectory,
      {
        inventory: () => Promise.resolve(exported),
        blob: (digest) => {
          const blob = exported.blobs.find((entry) => entry.digest === digest);
          if (blob === undefined) throw new Error("missing seeded blob");
          return Promise.resolve(Uint8Array.fromBase64(blob.data));
        },
      },
      100_000_000,
    );
    const replica = new Database(join(replicaDirectory, "replica.sqlite"));
    const actual = replica
      .query<
        { entity: string; id: string; payload: string; tombstone: number },
        []
      >(
        "SELECT entity, id, payload, tombstone FROM replica_records ORDER BY entity, id",
      )
      .all();
    const expected = exported.records
      .map((record) => ({ ...record, tombstone: record.tombstone ? 1 : 0 }))
      .sort((left, right) =>
        `${left.entity}\0${left.id}`.localeCompare(
          `${right.entity}\0${right.id}`,
        ),
      );
    expect(actual).toEqual(expected);
    const executorIds = exported.records
      .filter(({ entity }) => entity === "agent_sessions")
      .map(({ payload }) => parsedPayload(payload)["runner_id"]);
    expect(new Set(executorIds)).toEqual(new Set(["runners-1", "runners-2"]));
    for (const blob of exported.blobs) {
      expect(
        readFileSync(join(replicaDirectory, "blobs", blob.digest)),
      ).toEqual(Buffer.from(blob.data, "base64"));
    }
    replica.close();
  } finally {
    engine.$client.close();
  }
});
