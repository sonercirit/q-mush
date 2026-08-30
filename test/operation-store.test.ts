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
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import { createOperationStore } from "../sync-engine/operation-store";
import {
  testApplyState,
  testOperation,
  testSessionOperation,
} from "./operation-core-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const readEnvelopes = (
  store: Store,
  ...parameters: Parameters<Store["readEncodedEnvelopes"]>
) => {
  const page = store.readEncodedEnvelopes(...parameters);
  return {
    envelopes: page.envelopes.map(decodeOperationEnvelope),
    hasMore: page.hasMore,
  };
};
const changedOperation = (
  operation: ReturnType<typeof testOperation>,
  changes: Readonly<Partial<ReturnType<typeof testOperation>>>,
) => ({ ...operation, payload: { value: "changed" }, ...changes });
const expectedSequences = (count: number) =>
  Array.from({ length: count }, (_, index) => BigInt(index + 1));
const firstOperation = () => testOperation("writer-a", 1n, {}, "first");
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
const readWriterIds = (
  store: Store,
  frontier: Readonly<Record<string, bigint>>,
) =>
  readEnvelopes(store, "owner-1", "non-session", frontier, 20).envelopes.map(
    ({ writerId }) => writerId,
  );
const readFirstSequence = (store: Store) =>
  readEnvelopes(store, "owner-1", "non-session", {}, 1).envelopes[0]?.sequence;
const appendOutOfOrder = (store: Store) => {
  for (const [sequence, value] of [
    [2n, "two"],
    [1n, "one"],
  ] as const)
    append(store, "owner-1", testOperation("writer-a", sequence, {}, value));
};
const appendSequenceRange = (store: Store, count: number) => {
  for (let sequence = 1; sequence <= count; sequence += 1)
    append(
      store,
      "owner-1",
      testOperation("writer-a", BigInt(sequence), {}, "value"),
    );
};
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
  const first = firstOperation();
  expect(store.appendEnvelope("owner-1", first, SYSTEM_ID, 2)).toBe(true);
  expect(store.appendEnvelope("owner-1", first, SYSTEM_ID, 3)).toBe(false);
  expect(() =>
    store.appendEnvelope(
      "owner-1",
      changedOperation(first, { operationId: "different" }),
      SYSTEM_ID,
      4,
    ),
  ).toThrow("Operation identity equivocation");
});

test("operation identity conflicts across different writer sequences", () => {
  const store = setup();
  const first = firstOperation();
  append(store, "owner-1", first);
  expect(() =>
    append(
      store,
      "owner-1",
      changedOperation(testOperation("writer-b", 2n, {}, "second"), {
        operationId: first.operationId,
      }),
    ),
  ).toThrow("Operation identity equivocation");
});

test("operation envelope pages preserve bigint and cross-writer ordering", () => {
  const store = setup();
  const sequences = [
    9n,
    10n,
    2n ** 63n,
    2n ** 63n + 5n,
    2n ** 64n,
    12_000_000_000_000_000_000_000n,
  ];
  for (const writer of ["writer-b", "writer-a"])
    for (const sequence of sequences.slice().reverse())
      append(store, "owner-1", testOperation(writer, sequence, {}, "value", 1));
  expect(
    readEnvelopes(store, "owner-1", "non-session", {}, 20).envelopes.map(
      ({ writerId, sequence }) => [writerId, sequence],
    ),
  ).toEqual(
    ["writer-a", "writer-b"].flatMap((writer) =>
      sequences.map((sequence) => [writer, sequence]),
    ),
  );
});

test("operation envelope frontier includes a writer absent from the frontier", () => {
  const store = setup();
  for (const [writerId, value] of [
    ["writer-a", "a"],
    ["writer-b", "b"],
  ] as const)
    append(store, "owner-1", testOperation(writerId, 1n, {}, value));
  expect(readWriterIds(store, { "writer-a": 1n })).toEqual(["writer-b"]);
});

test("operation envelope pages preserve explicit intra-writer sequence order", () => {
  const store = setup();
  appendOutOfOrder(store);
  databaseForTest().$client.run(
    "DROP INDEX operation_envelopes_owner_partition_writer_index",
  );
  databaseForTest().$client.run("PRAGMA reverse_unordered_selects = ON");
  expect(readFirstSequence(store)).toBe(1n);
});

test("operation envelope frontier pages are complete and exactly bounded", () => {
  const store = setup();
  appendSequenceRange(store, 300);
  const first = readEnvelopes(store, "owner-1", "non-session", {}, 256);
  expect({ length: first.envelopes.length, hasMore: first.hasMore }).toEqual({
    length: 256,
    hasMore: true,
  });
  const lastSequence = first.envelopes.at(-1)?.sequence;
  expect(lastSequence).toBe(256n);
  const second = readEnvelopes(
    store,
    "owner-1",
    "non-session",
    { "writer-a": lastSequence ?? 0n },
    256,
  );
  expect({ length: second.envelopes.length, hasMore: second.hasMore }).toEqual({
    length: 44,
    hasMore: false,
  });
  expect(
    [...first.envelopes, ...second.envelopes].map(({ sequence }) => sequence),
  ).toEqual(expectedSequences(300));
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

test("operation envelope page at its exact limit is complete", () => {
  const store = setup();
  appendSequenceRange(store, 3);
  expect(readEnvelopes(store, "owner-1", "non-session", {}, 3).hasMore).toBe(
    false,
  );
});

test("operation envelope ordering crosses four-to-five-digit sequences", () => {
  const store = setup();
  for (const sequence of [10_000n, 9_999n])
    append(store, "owner-1", testOperation("writer-a", sequence, {}, "value"));
  expect(
    readEnvelopes(store, "owner-1", "non-session", {}, 2).envelopes.map(
      ({ sequence }) => sequence,
    ),
  ).toEqual([9_999n, 10_000n]);
});
