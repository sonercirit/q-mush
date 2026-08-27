import { afterEach, expect, test } from "vitest";
import { createdAuditFields } from "../shared/audit";
import {
  operationCheckpoints,
  operationEnvelopes,
  users,
} from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import { createOperationStore } from "../sync-engine/operation-store";
import {
  testApplyState,
  testOperation,
  testSessionOperation,
} from "./operation-core-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const harness = createOperationDatabaseHarness();
const setup = () => createOperationStore(harness.setup());
const databaseForTest = harness.current;
const addSecondOwner = () => {
  databaseForTest()
    .insert(users)
    .values({
      id: "owner-2",
      googleSubject: "subject-2",
      email: "two@example.com",
      name: "Two",
      ...createdAuditFields(SYSTEM_ID, 1),
    })
    .run();
};
type Store = ReturnType<typeof createOperationStore>;
type Partition = "non-session" | "session";
const checkpoint = (projection: readonly string[]) =>
  encodeOperationCheckpoint(testApplyState<readonly string[]>(projection));
const append = (
  store: Store,
  ownerId: string,
  operation: ReturnType<typeof testOperation>,
) => store.appendEnvelope(ownerId, operation, SYSTEM_ID, 2);
const saveCheckpoint = (
  store: Store,
  ownerId: string,
  partition: Partition,
  projection: readonly string[],
  now: number,
) => {
  store.storeCheckpoint(
    ownerId,
    partition,
    checkpoint(projection),
    SYSTEM_ID,
    now,
  );
};
const expectEnvelopeCount = (
  store: Store,
  ownerId: string,
  partition: Partition,
  count: number,
) => {
  expect(store.countEnvelopes(ownerId, partition)).toBe(count);
};
const replaceCheckpoint = (
  store: Store,
  preservedOwner: string,
  preservedPartition: Partition,
  preservedValue: string,
) => {
  saveCheckpoint(store, "owner-1", "session", ["initial"], 2);
  saveCheckpoint(
    store,
    preservedOwner,
    preservedPartition,
    [preservedValue],
    2,
  );
  saveCheckpoint(store, "owner-1", "session", ["updated"], 3);
};
const loadedProjection = (
  store: Store,
  ownerId: string,
  partition: Partition,
) =>
  decodeOperationCheckpoint(store.loadCheckpoint(ownerId, partition) ?? "")
    .projection;
afterEach(harness.close);

test("operation envelopes append idempotently and reject equivocation", () => {
  const store = setup();
  const first = testOperation("writer-a", 1n, {}, "first");
  expect(store.appendEnvelope("owner-1", first, SYSTEM_ID, 2)).toBe(true);
  expect(store.appendEnvelope("owner-1", first, SYSTEM_ID, 3)).toBe(false);
  expect(() =>
    store.appendEnvelope(
      "owner-1",
      { ...first, operationId: "different", payload: { value: "changed" } },
      SYSTEM_ID,
      4,
    ),
  ).toThrow("Operation identity equivocation");
});

test("operation envelopes isolate identities by owner", () => {
  const store = setup();
  addSecondOwner();
  const first = testOperation("writer-a", 1n, {}, "first");
  const conflicting = { ...first, payload: { value: "other" } };
  expect(conflicting.operationId).toBe(first.operationId);
  expect([
    append(store, "owner-1", first),
    append(store, "owner-2", conflicting),
  ]).toEqual([true, true]);
  expect(store.countEnvelopes("owner-2", "non-session")).toBe(1);
});

test("operation envelopes isolate identities by partition", () => {
  const store = setup();
  const first = testOperation("writer-a", BigInt(1), {}, "first");
  const session = testSessionOperation("writer-a", 1n, "first");
  expect([
    append(store, "owner-1", first),
    append(store, "owner-1", session),
  ]).toEqual([true, true]);
});

test("operation envelope counts are owner scoped", () => {
  const store = setup();
  addSecondOwner();
  const ownOperation = testOperation("writer-a", 1n, {}, "one");
  append(store, "owner-1", ownOperation);
  const otherOwnerOperation = testOperation("writer-b", 1n, {}, "two");
  append(store, "owner-2", otherOwnerOperation);
  expectEnvelopeCount(store, "owner-1", "non-session", 1);
});

test("operation envelope counts are partition scoped", () => {
  const store = setup();
  append(store, "owner-1", testOperation("writer-a", 1n, {}, "one"));
  append(store, "owner-1", testSessionOperation("writer-a", 1n, "two"));
  expectEnvelopeCount(store, "owner-1", "session", 1);
});

test("empty operation envelope histories count as zero", () => {
  expect(setup().countEnvelopes("owner-1", "non-session")).toBe(0);
});

test("encoded checkpoints replace atomically per owner and partition", () => {
  const store = setup();
  saveCheckpoint(store, "owner-1", "non-session", [], 2);
  saveCheckpoint(store, "owner-1", "non-session", ["next"], 3);
  expect(loadedProjection(store, "owner-1", "non-session")).toEqual(["next"]);
});

test("encoded checkpoint replacement is owner scoped", () => {
  const store = setup();
  addSecondOwner();
  replaceCheckpoint(store, "owner-2", "session", "two");
  expect(loadedProjection(store, "owner-2", "session")).toEqual(["two"]);
});

test("encoded checkpoint replacement is partition scoped", () => {
  const store = setup();
  replaceCheckpoint(store, "owner-1", "non-session", "other");
  expect(loadedProjection(store, "owner-1", "non-session")).toEqual(["other"]);
});

test("undecodable checkpoints are rejected before persistence", () => {
  const store = setup();
  expect(() => {
    store.storeCheckpoint("owner-1", "session", "invalid", SYSTEM_ID, 2);
  }).toThrow();
  expect(store.loadCheckpoint("owner-1", "session")).toBeUndefined();
});

test("soft-deleted envelopes do not dedupe or count", () => {
  const store = setup();
  const operation = testOperation("writer-a", 1n, {}, "first");
  append(store, "owner-1", operation);
  databaseForTest().update(operationEnvelopes).set({ isDeleted: true }).run();
  expectEnvelopeCount(store, "owner-1", "non-session", 0);
  expect(append(store, "owner-1", operation)).toBe(true);
});

test("soft-deleted checkpoints are not loaded or replaced", () => {
  const store = setup();
  saveCheckpoint(store, "owner-1", "session", ["old"], 2);
  databaseForTest().update(operationCheckpoints).set({ isDeleted: true }).run();
  expect(store.loadCheckpoint("owner-1", "session")).toBeUndefined();
  saveCheckpoint(store, "owner-1", "session", ["new"], 3);
  expect(loadedProjection(store, "owner-1", "session")).toEqual(["new"]);
});

test("envelope range plan uses the ordered owner index without sorting", () => {
  const database = harness.setup().database.$client;
  const plan = database
    .query<{ readonly detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT encoded_envelope FROM operation_envelopes WHERE user_id = 'owner-1' AND partition = 'non-session' AND is_deleted = 0 ORDER BY writer_id, sequence_order LIMIT 257",
    )
    .all()
    .map(({ detail }) => detail);
  expect(
    plan.some((detail) =>
      detail.includes(
        "SEARCH operation_envelopes USING INDEX operation_envelopes_owner_partition_writer_index",
      ),
    ),
  ).toBe(true);
  expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
});
