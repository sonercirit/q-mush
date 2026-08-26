import { expect, test } from "vitest";
import { createdAuditFields } from "../shared/audit";
import { createDatabase } from "../shared/database";
import {
  operationCheckpoints,
  operationEnvelopes,
  users,
} from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import { decodeOperationCheckpoint } from "../shared/operation-checkpoint";
import { createOperationIntake } from "../sync-engine/operation-intake";
import {
  appendOperationId,
  testOperation,
} from "./operation-core-test-support";

const setup = () => {
  const database = createDatabase(":memory:");
  database
    .insert(users)
    .values({
      id: "owner-1",
      googleSubject: "subject",
      email: "owner@example.com",
      name: "Owner",
      ...createdAuditFields(SYSTEM_ID, 1),
    })
    .run();
  let id = 0;
  const intake = createOperationIntake({
    database,
    generateId: () => `id-${String(++id)}`,
  });
  return { database, intake };
};

test("operation intake is replay-idempotent and checkpoints applied state", () => {
  const { database, intake } = setup();
  const operation = testOperation("writer-a", 1n, {}, "one");
  const first = intake.apply(
    "owner-1",
    "non-session",
    [operation],
    appendOperationId,
    SYSTEM_ID,
    2,
  );
  const replay = intake.apply(
    "owner-1",
    "non-session",
    [operation],
    appendOperationId,
    SYSTEM_ID,
    3,
  );
  expect(replay.encodedCheckpoint).toBe(first.encodedCheckpoint);
  expect(
    decodeOperationCheckpoint(replay.encodedCheckpoint).projection,
  ).toEqual([operation.operationId]);
  expect(database.select().from(operationEnvelopes).all()).toHaveLength(1);
  database.$client.close();
});

test("operation intake retains out-of-order operations pending and drains them", () => {
  const { database, intake } = setup();
  const second = testOperation("writer-a", 2n, { "writer-a": 1n }, "two");
  const pending = intake.apply(
    "owner-1",
    "non-session",
    [second],
    appendOperationId,
    SYSTEM_ID,
    2,
  );
  expect(decodeOperationCheckpoint(pending.encodedCheckpoint).pending).toEqual([
    second,
  ]);
  const first = testOperation("writer-a", 1n, {}, "one");
  const drained = intake.apply(
    "owner-1",
    "non-session",
    [first],
    appendOperationId,
    SYSTEM_ID,
    3,
  );
  expect(drained.frontier).toEqual({ "writer-a": 2n });
  expect(
    decodeOperationCheckpoint(drained.encodedCheckpoint).projection,
  ).toEqual([first.operationId, second.operationId]);
  database.$client.close();
});

test("operation intake rejects equivocation", () => {
  const { database, intake } = setup();
  const operation = testOperation("writer-a", 1n, {}, "one");
  intake.apply(
    "owner-1",
    "non-session",
    [operation],
    appendOperationId,
    SYSTEM_ID,
    2,
  );
  expect(() =>
    intake.apply(
      "owner-1",
      "non-session",
      [{ ...operation, payload: { value: "other" } }],
      appendOperationId,
      SYSTEM_ID,
      3,
    ),
  ).toThrow("equivocation");
  database.$client.close();
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
  database.$client.close();
});
