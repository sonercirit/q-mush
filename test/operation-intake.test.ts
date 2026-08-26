import { afterEach, expect, test } from "vitest";
import {
  operationCheckpoints,
  operationEnvelopes,
} from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import { decodeOperationCheckpoint } from "../shared/operation-checkpoint";
import { MAX_OPERATION_BATCH_SIZE } from "../shared/operation-core";
import { createOperationIntake } from "../sync-engine/operation-intake";
import {
  appendOperationId,
  testOperation,
} from "./operation-core-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const harness = createOperationDatabaseHarness();
const setup = () => {
  const resources = harness.setup();
  return {
    database: resources.database,
    intake: createOperationIntake(resources),
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
afterEach(harness.close);
const apply = (
  intake: ReturnType<typeof createOperationIntake>,
  operations: Parameters<ReturnType<typeof createOperationIntake>["apply"]>[2],
  now: number,
) =>
  intake.apply(
    "owner-1",
    "non-session",
    operations,
    appendOperationId,
    SYSTEM_ID,
    now,
  );

test("operation intake is replay-idempotent", () => {
  const { database, intake, operation } = setupWithOperation();
  const first = apply(intake, [operation], 2);
  const replay = apply(intake, [operation], 3);
  expect(replay.encodedCheckpoint).toBe(first.encodedCheckpoint);
  expect(storedRows(database, operationEnvelopes)).toHaveLength(1);
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

test("operation intake rejects equivocation", () => {
  const { intake, operation } = setupWithOperation();
  apply(intake, [operation], 2);
  expect(() =>
    apply(intake, [{ ...operation, payload: { value: "other" } }], 3),
  ).toThrow("equivocation");
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
  const operations = operationsOfLength(MAX_OPERATION_BATCH_SIZE);
  expect(Object.keys(apply(intake, operations, 2).frontier)).toHaveLength(
    MAX_OPERATION_BATCH_SIZE,
  );
});

test("operation intake rejects a batch above its maximum size", () => {
  const { intake } = setup();
  const operations = operationsOfLength(MAX_OPERATION_BATCH_SIZE + 1);
  expect(() => apply(intake, operations, 2)).toThrow("batch is too large");
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
