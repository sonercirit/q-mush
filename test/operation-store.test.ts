import { afterEach, expect, test } from "vitest";
import { createdAuditFields } from "../shared/audit";
import type { createDatabase } from "../shared/database";
import { users } from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import { createOperationStore } from "../sync-engine/operation-store";
import { testApplyState, testOperation } from "./operation-core-test-support";
import { setupOperationDatabase } from "./operation-store-test-support";

const databases: ReturnType<typeof createDatabase>[] = [];
const setup = () => {
  const resources = setupOperationDatabase();
  databases.push(resources.database);
  return createOperationStore(resources);
};
const databaseForTest = () => {
  const database = databases[0];
  if (database === undefined) throw new Error("Missing test database");
  return database;
};
const failOperation = (): never => {
  throw new Error("Missing test operation");
};
afterEach(() => {
  for (const database of databases.splice(0)) database.$client.close();
});

test("operation envelopes append idempotently and reject equivocation", () => {
  const store = setup();
  const first = testOperation("writer-a", 1n, {}, "first");
  expect(store.appendEnvelope("owner-1", first, SYSTEM_ID, 2)).toBe(true);
  expect(store.appendEnvelope("owner-1", first, SYSTEM_ID, 3)).toBe(false);
  const equivocation = {
    ...first,
    operationId: "different",
    payload: { value: "changed" },
  };
  expect(() =>
    store.appendEnvelope("owner-1", equivocation, SYSTEM_ID, 4),
  ).toThrow("Operation identity equivocation");
});

test("operation envelope ranges are owner scoped, frontier filtered, and bounded", () => {
  const store = setup();
  const otherDatabase = databaseForTest();
  otherDatabase
    .insert(users)
    .values({
      id: "owner-2",
      googleSubject: "subject-2",
      email: "two@example.com",
      name: "Two",
      ...createdAuditFields(SYSTEM_ID, 1),
    })
    .run();
  const operations = [
    testOperation("writer-a", 1n, {}, "a1"),
    testOperation("writer-a", 2n, { "writer-a": 1n }, "a2"),
    testOperation("writer-b", 1n, {}, "b1"),
  ];
  for (const operation of operations)
    store.appendEnvelope("owner-1", operation, SYSTEM_ID, 2);
  store.appendEnvelope(
    "owner-2",
    operations[0] ?? failOperation(),
    SYSTEM_ID,
    2,
  );
  expect(
    store.readEnvelopeRange("owner-1", "non-session", { "writer-a": 1n }, 1),
  ).toEqual([operations[1]]);
});

test("encoded checkpoints replace atomically per owner and partition", () => {
  const store = setup();
  const first = encodeOperationCheckpoint(
    testApplyState<readonly string[]>([]),
  );
  const second = encodeOperationCheckpoint(
    testApplyState<readonly string[]>(["next"]),
  );
  expect(store.loadCheckpoint("owner-1", "non-session")).toBeUndefined();
  store.storeCheckpoint("owner-1", "non-session", first, SYSTEM_ID, 2);
  store.storeCheckpoint("owner-1", "non-session", second, SYSTEM_ID, 3);
  expect(
    decodeOperationCheckpoint(
      store.loadCheckpoint("owner-1", "non-session") ?? "",
    ).projection,
  ).toEqual(["next"]);
});
