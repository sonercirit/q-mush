import { afterEach, expect, test } from "vitest";
import {
  operationCheckpoints,
  operationEnvelopes,
} from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import { decodeOperationCheckpoint } from "../shared/operation-checkpoint";
import {
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_CHECKPOINT_BYTES,
  MAX_OWNER_PARTITION_OPERATIONS,
} from "../shared/operation-core";
import {
  createOperationIntake,
  type OperationIntakeLimits,
} from "../sync-engine/operation-intake";
import {
  appendOperationId,
  testOperation,
  testSessionOperation,
} from "./operation-core-test-support";
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
  operation: testOperation("writer-a", 1n, {}, "one"),
});
const checkpointProjection = (encodedCheckpoint: string) =>
  decodeOperationCheckpoint(encodedCheckpoint).projection;
const storedRows = (
  database: ReturnType<typeof setup>["database"],
  table: typeof operationEnvelopes | typeof operationCheckpoints,
) => database.select().from(table).all();
const expectStoredEnvelopeCount = (
  database: ReturnType<typeof setup>["database"],
  count: number,
) => {
  expect(storedRows(database, operationEnvelopes)).toHaveLength(count);
};
const expectNoStoredOperations = (
  database: ReturnType<typeof setup>["database"],
) => {
  expect(storedRows(database, operationEnvelopes)).toEqual([]);
  expect(storedRows(database, operationCheckpoints)).toEqual([]);
};
const operationsOfLength = (length: number) =>
  Array.from({ length }, (_, index) =>
    testOperation(`writer-${String(index)}`, 1n, {}, "one"),
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
) =>
  intake.apply(
    "owner-1",
    partition,
    operations,
    appendOperationId,
    SYSTEM_ID,
    now,
  );
afterEach(harness.close);
const apply = (intake: Intake, operations: IntakeOperations, now: number) =>
  applyPartition(intake, "non-session", operations, now);
const expectPartitionSequenceSpaces = (
  firstPartition: "non-session" | "session",
) => {
  const { intake } = setup();
  const session = testSessionOperation("writer-a", 1n, "session");
  const nonSession = testOperation("writer-a", 1n, {}, "workspace");
  const byPartition = { "non-session": nonSession, session };
  const secondPartition =
    firstPartition === "session" ? "non-session" : "session";
  expect(
    applyPartition(intake, firstPartition, [byPartition[firstPartition]], 2)
      .frontier,
  ).toEqual({ "writer-a": 1n });
  expect(
    applyPartition(intake, secondPartition, [byPartition[secondPartition]], 3)
      .frontier,
  ).toEqual({ "writer-a": 1n });
};

test("operation intake advances non-session then session sequence spaces independently", () => {
  expectPartitionSequenceSpaces("non-session");
});

test("operation intake advances session then non-session sequence spaces independently", () => {
  expectPartitionSequenceSpaces("session");
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
  expect(checkpointProjection(stored?.encodedCheckpoint ?? "")).toEqual([
    operation.operationId,
  ]);
});

test("operation intake retains out-of-order operations pending and drains them", () => {
  const { intake } = setup();
  const second = testOperation("writer-a", 2n, { "writer-a": 1n }, "two");
  const pending = apply(intake, [second], 2);
  expect(decodeOperationCheckpoint(pending.encodedCheckpoint).pending).toEqual([
    second,
  ]);
  const first = testOperation("writer-a", 1n, {}, "one");
  const drained = apply(intake, [first], 3);
  expect(drained.frontier).toEqual({ "writer-a": 2n });
  expect(checkpointProjection(drained.encodedCheckpoint)).toEqual([
    first.operationId,
    second.operationId,
  ]);
});

test("operation intake rejects equivocation and rolls back its batch", () => {
  const { database, intake, operation } = setupWithOperation();
  const conflicting = { ...operation, payload: { value: "other" } };
  expect(() => apply(intake, [operation, conflicting], 3)).toThrow(
    "equivocation",
  );
  expectNoStoredOperations(database);
});

test("operation intake rejects a mismatched operation partition", () => {
  const { database, intake } = setup();
  const operation = {
    ...testOperation("writer-a", 1n, {}, "one"),
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

test("operation intake default path enforces the owner-partition constant", () => {
  const { database, intake } = setup();
  database.$client.run(
    `WITH RECURSIVE rows(sequence) AS (
      SELECT 1 UNION ALL SELECT sequence + 1 FROM rows WHERE sequence < ?
    )
    INSERT INTO operation_envelopes
      (id, user_id, created_at, created_by_id, updated_at, updated_by_id,
       partition, writer_id, sequence, sequence_order, operation_id,
       fingerprint, encoded_envelope)
    SELECT 'bulk-' || sequence, 'owner-1', 1, ?, 1, ?, 'non-session',
      'bulk-writer', CAST(sequence AS TEXT), printf('%05d:%d',
      length(CAST(sequence AS TEXT)), sequence), 'bulk-operation-' || sequence,
      'bulk-fingerprint-' || sequence, 'unused'
    FROM rows`,
    [MAX_OWNER_PARTITION_OPERATIONS - 1, SYSTEM_ID, SYSTEM_ID],
  );
  expect(
    apply(intake, [testOperation("final-writer", 1n, {}, "final")], 2).frontier,
  ).toEqual({ "final-writer": 1n });
});

test("operation intake rejects owner-partition history above its capacity", () => {
  const { intake } = setup({ ownerPartitionOperations: 2 });
  apply(intake, operationsOfLength(2), 2);
  expect(() =>
    apply(intake, [testOperation("overflow", 1n, {}, "one")], 3),
  ).toThrow("history capacity reached");
});

test("operation intake history capacity is independent per partition", () => {
  const { intake } = setup();
  applyPartition(
    intake,
    "session",
    [testSessionOperation("writer-a", 1n, "session")],
    2,
  );
  expect(
    apply(intake, [testOperation("writer-a", 1n, {}, "one")], 3).frontier,
  ).toEqual({ "writer-a": 1n });
});

test("operation intake history capacity counts stored envelopes, not replays", () => {
  const { database, intake, operation } = setupWithOperation();
  apply(intake, [operation], 2);
  apply(intake, [operation], 3);
  expectStoredEnvelopeCount(database, 1);
});

test("operation intake rejects checkpoints above their byte capacity", () => {
  const { database, intake } = setup();
  const operation = testOperation(
    "writer-a",
    1n,
    {},
    "x".repeat(MAX_OPERATION_CHECKPOINT_BYTES),
  );
  const result = () => apply(intake, [operation], 2);
  expect(result).toThrow("checkpoint capacity reached");
  expectNoStoredOperations(database);
});
test("operation intake rolls back envelopes when projection persistence fails", () => {
  const { database, intake, operation } = setupWithOperation();
  expect(() =>
    intake.apply(
      "owner-1",
      "non-session",
      [operation],
      () => {
        throw new Error("projection failed");
      },
      SYSTEM_ID,
      2,
    ),
  ).toThrow("projection failed");
  expectNoStoredOperations(database);
});
