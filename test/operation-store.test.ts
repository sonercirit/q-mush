import { afterEach, expect, test } from "vitest";
import { createdAuditFields } from "../shared/audit";
import { users } from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import { createOperationStore } from "../sync-engine/operation-store";
import { testApplyState, testOperation } from "./operation-core-test-support";
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
const readRange = (
  store: Store,
  frontier: Readonly<Record<string, bigint>>,
  limit: number,
) => store.readEnvelopeRange("owner-1", "non-session", frontier, limit);
const appendPair = (
  store: Store,
  secondWriter: string,
  secondSequence: bigint,
  secondFrontier: Readonly<Record<string, bigint>>,
) => {
  const first = testOperation("writer-a", 1n, {}, "first");
  const second = testOperation(
    secondWriter,
    secondSequence,
    secondFrontier,
    "second",
  );
  append(store, "owner-1", first);
  append(store, "owner-1", second);
  return { first, second };
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

test("operation envelope ranges are owner scoped", () => {
  const store = setup();
  addSecondOwner();
  const own = testOperation("writer-a", 1n, {}, "own");
  const other = testOperation("writer-b", 1n, {}, "other");
  append(store, "owner-1", own);
  append(store, "owner-2", other);
  expect(store.readEnvelopeRange("owner-1", "non-session", {}, 10)).toEqual([
    own,
  ]);
});

test("operation envelope ranges are partition scoped", () => {
  const store = setup();
  const nonSession = testOperation("writer-a", 1n, {}, "non-session");
  const sessionBase = testOperation("writer-b", 1n, {}, "session");
  const session = {
    ...sessionBase,
    entity: { ...sessionBase.entity, type: "agent_sessions" },
    partition: "session" as const,
  };
  append(store, "owner-1", nonSession);
  append(store, "owner-1", session);
  expect(store.readEnvelopeRange("owner-1", "session", {}, 10)).toEqual([
    session,
  ]);
});

test("operation envelope ranges filter the causal frontier", () => {
  const store = setup();
  const { second } = appendPair(store, "writer-a", 2n, { "writer-a": 1n });
  expect(readRange(store, { "writer-a": 1n }, 10)).toEqual([second]);
});

test("operation envelope ranges apply each writer frontier before limiting", () => {
  const store = setup();
  appendPair(store, "writer-b", 1n, {});
  const writerC = testOperation("writer-c", 1n, {}, "third");
  append(store, "owner-1", writerC);
  expect(readRange(store, { "writer-a": 1n, "writer-b": 1n }, 1)).toEqual([
    writerC,
  ]);
});

test("operation envelope ranges honor their limit", () => {
  const store = setup();
  const { first } = appendPair(store, "writer-b", 1n, {});
  expect(readRange(store, {}, 1)).toEqual([first]);
});

test("operation envelope range limits must be positive", () => {
  const store = setup();
  expect(() =>
    store.readEnvelopeRange("owner-1", "non-session", {}, 0),
  ).toThrow("must be positive");
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
