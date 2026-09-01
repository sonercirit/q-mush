import { afterEach, expect, test } from "vitest";
import {
  operationCheckpoints,
  operationEnvelopes,
} from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import {
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_CHECKPOINT_BYTES,
  MAX_OWNER_PARTITION_OPERATIONS,
  operationFingerprint,
  operationSequenceOrder,
} from "../shared/operation-core";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import {
  createOperationIntake,
  type OperationIntakeLimits,
} from "../sync-engine/operation-intake";
import { createOperationStore } from "../sync-engine/operation-store";
import { entityTestOperation } from "./operation-entity-test-support";
import {
  expectCheckpointOperationFingerprint,
  expectIdempotentCheckpoint,
  expectSessionIntakeRejection,
  expectWorkspaceProjectionName,
} from "./operation-intake-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const harness = createOperationDatabaseHarness();
const setup = (limits?: OperationIntakeLimits) => {
  const resources = harness.setup();
  return {
    database: resources.database,
    intake: createOperationIntake(
      limits === undefined ? resources : { ...resources, limits },
    ),
  };
};
const setupWithOperation = () => ({
  ...setup(),
  operation: entityTestOperation("writer-a", 1n, {}, "one"),
});
const storedRows = (
  database: ReturnType<typeof setup>["database"],
  table: typeof operationEnvelopes | typeof operationCheckpoints,
) => database.select().from(table).all();
const storedEnvelopeRows = (database: ReturnType<typeof setup>["database"]) =>
  database.select().from(operationEnvelopes).all();
const expectStoredEnvelopeCount = (
  database: ReturnType<typeof setup>["database"],
  count: number,
) => {
  expect(storedEnvelopeRows(database)).toHaveLength(count);
};
const expectNoStoredOperations = (
  database: ReturnType<typeof setup>["database"],
) => {
  expect(storedRows(database, operationEnvelopes)).toEqual([]);
  expect(storedRows(database, operationCheckpoints)).toEqual([]);
};
const operationsOfLength = (length: number) =>
  Array.from({ length }, (_, index) =>
    entityTestOperation(`writer-${String(index)}`, 1n, {}, "one"),
  );
const applyOperationCount = (
  intake: ReturnType<typeof createOperationIntake>,
  length: number,
) => apply(intake, operationsOfLength(length), 2);
type Intake = ReturnType<typeof createOperationIntake>;
type IntakeOperations = Parameters<Intake["apply"]>[2];
const applyPartition = (
  intake: Intake,
  partition: "non-session" | "session",
  operations: IntakeOperations,
  now: number,
) => intake.apply("owner-1", partition, operations, SYSTEM_ID, now);
afterEach(harness.close);
const apply = (intake: Intake, operations: IntakeOperations, now: number) =>
  applyPartition(intake, "non-session", operations, now);
test("operation intake fails closed for session operations", () => {
  expectSessionIntakeRejection(setup().intake);
});

test("operation intake persists one snapshot consistently and replays it as a duplicate", () => {
  const resources = harness.setup();
  const database = resources.database;
  const intake = createOperationIntake(resources);
  const operation = entityTestOperation("writer-a", 1n, {}, "one");
  const originalPayload = { name: "one" };
  const payload = new Proxy(originalPayload, {
    get: () => "get-trap-value",
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      return descriptor === undefined
        ? undefined
        : { ...descriptor, value: "snapshot-value" };
    },
  });
  const candidate = { ...operation, payload };
  const first = apply(intake, [candidate], 2);
  const [row] = storedEnvelopeRows(database);
  const stored = decodeOperationEnvelope(row?.encodedEnvelope ?? "");
  expect(stored.payload).toEqual({ name: "snapshot-value" });
  expect(row?.fingerprint).toBe(operationFingerprint(stored));
  expectCheckpointOperationFingerprint(
    first.encodedCheckpoint,
    row?.fingerprint,
  );
  expectIdempotentCheckpoint(intake, stored, first.encodedCheckpoint);
  expectStoredEnvelopeCount(database, 1);
});

test("operation intake persists frozen defensive operation snapshots", () => {
  const resources = setup();
  const { database, intake } = resources;
  const operation = entityTestOperation("frozen-writer", 1n, {}, "immutable");
  const originalFingerprint = operationFingerprint(operation);
  const first = apply(intake, [operation], 2);
  const row = storedEnvelopeRows(database).at(0);
  const stored = decodeOperationEnvelope(row?.encodedEnvelope ?? "");
  expect(
    [stored, stored.payload, stored.parents, stored.clock, stored.entity].every(
      Object.isFrozen,
    ),
  ).toBe(true);
  expect(row?.fingerprint).toBe(originalFingerprint);
  expect(operationFingerprint(stored)).toBe(originalFingerprint);
  expectCheckpointOperationFingerprint(
    first.encodedCheckpoint,
    originalFingerprint,
  );
  expectWorkspaceProjectionName(first.encodedCheckpoint, "immutable");
  expectIdempotentCheckpoint(intake, stored, first.encodedCheckpoint);
  expect(storedEnvelopeRows(database)).toHaveLength(1);
});

test("operation intake is replay-idempotent", () => {
  const { database, intake, operation } = setupWithOperation();
  const first = apply(intake, [operation], 2);
  const replay = apply(intake, [operation], 3);
  expect(replay.encodedCheckpoint).toBe(first.encodedCheckpoint);
  expectStoredEnvelopeCount(database, 1);
});

test("operation intake checkpoints applied state for round-trip", () => {
  const { database, intake, operation } = setupWithOperation();
  const result = apply(intake, [operation], 2);
  const [stored] = database.select().from(operationCheckpoints).all();
  expect(stored?.encodedCheckpoint).toBe(result.encodedCheckpoint);
  expectWorkspaceProjectionName(stored?.encodedCheckpoint ?? "", "one");
});

test("operation intake retains out-of-order operations pending and drains them", () => {
  const { intake } = setup();
  const second = entityTestOperation("writer-a", 2n, { "writer-a": 1n }, "two");
  const pending = apply(intake, [second], 2);
  expect(
    decodeOperationCheckpoint(
      pending.encodedCheckpoint,
      operationEntityProjectionCodec,
    ).pending,
  ).toEqual([second]);
  const first = entityTestOperation("writer-a", 1n, {}, "one");
  const drained = apply(intake, [first], 3);
  expect(drained.frontier).toEqual({ "writer-a": 2n });
  expectWorkspaceProjectionName(drained.encodedCheckpoint, "one");
});

test("operation intake rejects equivocation and rolls back its batch", () => {
  const { database, intake, operation } = setupWithOperation();
  const conflicting = { ...operation, payload: { name: "other" } };
  expect(() => apply(intake, [operation, conflicting], 3)).toThrow(
    "equivocation",
  );
  expectNoStoredOperations(database);
});

test("operation intake rejects a mismatched operation partition", () => {
  const { database, intake } = setup();
  const operation = {
    ...entityTestOperation("writer-a", 1n, {}, "one"),
    partition: "session" as const,
  };
  expect(() => apply(intake, [operation], 2)).toThrow("scope mismatch");
  expectNoStoredOperations(database);
});

test("operation intake accepts its maximum batch size", () => {
  const { intake } = setup();
  expect(
    Object.keys(applyOperationCount(intake, MAX_OPERATION_BATCH_SIZE).frontier),
  ).toHaveLength(MAX_OPERATION_BATCH_SIZE);
});

test("operation intake rejects a batch above its maximum size", () => {
  const { intake } = setup();
  expect(() =>
    applyOperationCount(intake, MAX_OPERATION_BATCH_SIZE + 1),
  ).toThrow("batch is too large");
});

test("operation intake retained capacity ignores folded envelope history", () => {
  expect(MAX_OWNER_PARTITION_OPERATIONS).toBe(2_000);
  const { database, intake } = setup();
  const seededEnvelope = encodeOperationEnvelope(
    entityTestOperation("bulk-writer", 1n, {}, "seeded"),
  );
  database.$client.run(
    `WITH RECURSIVE rows(sequence) AS (
      SELECT 1 UNION ALL SELECT sequence + 1 FROM rows WHERE sequence < ?
    )
    INSERT INTO operation_envelopes
      (id, user_id, created_at, created_by_id, updated_at, updated_by_id,
       partition, writer_id, sequence, sequence_order, operation_id,
       fingerprint, encoded_envelope)
    SELECT 'bulk-' || sequence, 'owner-1', 1, ?, 1, ?, 'non-session',
      'bulk-writer', CAST(sequence AS TEXT), ?, 'bulk-operation-' || sequence,
      'bulk-fingerprint-' || sequence, ?
    FROM rows`,
    [
      MAX_OWNER_PARTITION_OPERATIONS - 1,
      SYSTEM_ID,
      SYSTEM_ID,
      operationSequenceOrder(1n),
      seededEnvelope,
    ],
  );
  expect(
    createOperationStore({ database })
      .readEncodedEnvelopes("owner-1", "non-session", {}, 1)
      .envelopes.map(decodeOperationEnvelope),
  ).toEqual([entityTestOperation("bulk-writer", 1n, {}, "seeded")]);
  expect(
    apply(intake, [entityTestOperation("final-writer", 1n, {}, "final")], 2)
      .frontier,
  ).toEqual({ "final-writer": 1n });
  expect(
    apply(
      intake,
      [entityTestOperation("overflow-writer", 1n, {}, "overflow")],
      3,
    ).frontier,
  ).toEqual({ "final-writer": 1n, "overflow-writer": 1n });
  expectStoredEnvelopeCount(database, MAX_OWNER_PARTITION_OPERATIONS + 1);
});

test("operation intake rejects owner-partition history above its capacity", () => {
  const { intake } = setup({ ownerPartitionOperations: 2 });
  apply(intake, operationsOfLength(2), 2);
  expect(() =>
    apply(intake, [entityTestOperation("overflow", 1n, {}, "one")], 3),
  ).toThrow("history capacity reached");
});

test("operation intake duplicate older than drift remains acknowledged", () => {
  const { intake } = setup();
  const old = entityTestOperation("writer-a", 1n, {}, "old", 1);
  apply(intake, [old], 1);
  expect(() => apply(intake, [old], 600_002)).not.toThrow();
  expect(() =>
    apply(
      intake,
      [entityTestOperation("writer-b", 1n, {}, "new identity", 1)],
      600_002,
    ),
  ).toThrow(/drift bound/);
});

test("operation intake leaves session capacity unavailable", () => {
  const { intake } = setup();
  expectSessionIntakeRejection(intake);
  expect(
    apply(intake, [entityTestOperation("writer-a", 1n, {}, "one")], 3).frontier,
  ).toEqual({ "writer-a": 1n });
});

test("operation intake history capacity counts stored envelopes, not replays", () => {
  const { database, intake, operation } = setupWithOperation();
  apply(intake, [operation], 2);
  apply(intake, [operation], 3);
  expectStoredEnvelopeCount(database, 1);
});

test("operation intake rejects checkpoints above their byte capacity", () => {
  const { database, intake } = setup({});
  const operation = entityTestOperation(
    "capacity-writer",
    1n,
    {},
    "x".repeat(MAX_OPERATION_CHECKPOINT_BYTES),
  );
  const result = () => apply(intake, [operation], 2);
  expect(result).toThrow("checkpoint capacity reached");
  expectNoStoredOperations(database);
});
