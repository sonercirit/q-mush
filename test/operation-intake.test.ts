import { afterEach, expect, test } from "vitest";
import {
  operationCheckpoints,
  operationEnvelopes,
} from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import { decodeOperationCheckpoint } from "../shared/operation-checkpoint";
import { createOperationIntake } from "../sync-engine/operation-intake";
import {
  appendOperationId,
  testOperation,
} from "./operation-core-test-support";
import { setupOperationDatabase } from "./operation-store-test-support";

const databases: ReturnType<typeof setupOperationDatabase>["database"][] = [];
const setup = () => {
  const resources = setupOperationDatabase();
  databases.push(resources.database);
  return {
    database: resources.database,
    intake: createOperationIntake(resources),
  };
};
afterEach(() => {
  for (const database of databases.splice(0)) database.$client.close();
});
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

test("operation intake is replay-idempotent and checkpoints applied state", () => {
  const { database, intake } = setup();
  const operation = testOperation("writer-a", 1n, {}, "one");
  const first = apply(intake, [operation], 2);
  const replay = apply(intake, [operation], 3);
  expect(replay.encodedCheckpoint).toBe(first.encodedCheckpoint);
  expect(
    decodeOperationCheckpoint(replay.encodedCheckpoint).projection,
  ).toEqual([operation.operationId]);
  expect(database.select().from(operationEnvelopes).all()).toHaveLength(1);
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
  expect(
    decodeOperationCheckpoint(drained.encodedCheckpoint).projection,
  ).toEqual([first.operationId, second.operationId]);
});

test("operation intake rejects equivocation", () => {
  const { intake } = setup();
  const operation = testOperation("writer-a", 1n, {}, "one");
  apply(intake, [operation], 2);
  expect(() =>
    apply(intake, [{ ...operation, payload: { value: "other" } }], 3),
  ).toThrow("equivocation");
});

test("operation intake rolls back envelopes when projection persistence fails", () => {
  const { database, intake } = setup();
  const operation = testOperation("writer-a", 1n, {}, "one");
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
  expect(database.select().from(operationEnvelopes).all()).toEqual([]);
  expect(database.select().from(operationCheckpoints).all()).toEqual([]);
});
