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
const checkpoint = (projection: readonly string[]) =>
  encodeOperationCheckpoint(testApplyState<readonly string[]>(projection));
const loadedProjection = (
  store: ReturnType<typeof createOperationStore>,
  ownerId: string,
  partition: "non-session" | "session",
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
  store.appendEnvelope("owner-1", own, SYSTEM_ID, 2);
  store.appendEnvelope("owner-2", other, SYSTEM_ID, 2);
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
  store.appendEnvelope("owner-1", nonSession, SYSTEM_ID, 2);
  store.appendEnvelope("owner-1", session, SYSTEM_ID, 2);
  expect(store.readEnvelopeRange("owner-1", "session", {}, 10)).toEqual([
    session,
  ]);
});

test("operation envelope ranges filter the causal frontier", () => {
  const store = setup();
  const first = testOperation("writer-a", 1n, {}, "first");
  const second = testOperation("writer-a", 2n, { "writer-a": 1n }, "second");
  store.appendEnvelope("owner-1", first, SYSTEM_ID, 2);
  store.appendEnvelope("owner-1", second, SYSTEM_ID, 2);
  expect(
    store.readEnvelopeRange("owner-1", "non-session", { "writer-a": 1n }, 10),
  ).toEqual([second]);
});

test("operation envelope ranges honor their limit", () => {
  const store = setup();
  const first = testOperation("writer-a", 1n, {}, "first");
  const second = testOperation("writer-b", 1n, {}, "second");
  store.appendEnvelope("owner-1", first, SYSTEM_ID, 2);
  store.appendEnvelope("owner-1", second, SYSTEM_ID, 2);
  expect(store.readEnvelopeRange("owner-1", "non-session", {}, 1)).toEqual([
    first,
  ]);
});

test("operation envelope range limits must be positive", () => {
  const store = setup();
  expect(() =>
    store.readEnvelopeRange("owner-1", "non-session", {}, 0),
  ).toThrow("must be positive");
});

test("encoded checkpoints replace atomically per owner and partition", () => {
  const store = setup();
  store.storeCheckpoint("owner-1", "non-session", checkpoint([]), SYSTEM_ID, 2);
  store.storeCheckpoint(
    "owner-1",
    "non-session",
    checkpoint(["next"]),
    SYSTEM_ID,
    3,
  );
  expect(loadedProjection(store, "owner-1", "non-session")).toEqual(["next"]);
});

test("encoded checkpoint replacement is owner scoped", () => {
  const store = setup();
  addSecondOwner();
  store.storeCheckpoint(
    "owner-1",
    "session",
    checkpoint(["one"]),
    SYSTEM_ID,
    2,
  );
  store.storeCheckpoint(
    "owner-2",
    "session",
    checkpoint(["two"]),
    SYSTEM_ID,
    2,
  );
  store.storeCheckpoint(
    "owner-1",
    "session",
    checkpoint(["updated"]),
    SYSTEM_ID,
    3,
  );
  expect(loadedProjection(store, "owner-2", "session")).toEqual(["two"]);
});

test("encoded checkpoint replacement is partition scoped", () => {
  const store = setup();
  store.storeCheckpoint(
    "owner-1",
    "session",
    checkpoint(["session"]),
    SYSTEM_ID,
    2,
  );
  store.storeCheckpoint(
    "owner-1",
    "non-session",
    checkpoint(["other"]),
    SYSTEM_ID,
    2,
  );
  store.storeCheckpoint(
    "owner-1",
    "session",
    checkpoint(["updated"]),
    SYSTEM_ID,
    3,
  );
  expect(loadedProjection(store, "owner-1", "non-session")).toEqual(["other"]);
});

test("undecodable checkpoints are rejected before persistence", () => {
  const store = setup();
  expect(() => {
    store.storeCheckpoint("owner-1", "session", "invalid", SYSTEM_ID, 2);
  }).toThrow();
  expect(store.loadCheckpoint("owner-1", "session")).toBeUndefined();
});
