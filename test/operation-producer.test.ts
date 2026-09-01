import { expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { compareClocks, createOperation } from "../shared/operation-core";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import { createOperationIntake } from "../sync-engine/operation-intake";
import {
  createOperationProducer,
  type OperationProducerIntent,
} from "../sync-engine/operation-producer";
import { createOperationStore } from "../sync-engine/operation-store";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const ownerId = "owner-1";
const workspace = (id: string, name: string): OperationProducerIntent => ({
  type: "entity",
  entity: { type: "workspaces", id },
  kind: "workspace.create",
  payload: { name },
});
const projection = (store: ReturnType<typeof createOperationStore>) =>
  decodeOperationCheckpoint(
    store.loadCheckpoint(ownerId, "non-session") ?? "",
    operationEntityProjectionCodec,
  ).projection;

test("producer mints past a stored future sequence and chains clocks and parents", () => {
  const harness = createOperationDatabaseHarness();
  const { database } = harness.setup();
  const future = createOperation({
    operationId: "future",
    schemaVersion: 1,
    writerId: ownerId,
    sequence: 50n,
    clock: { physicalMs: 10_000, logical: 7, writerId: ownerId },
    parents: {},
    entity: { type: "workspaces", id: "future", accountId: ownerId },
    kind: "workspace.create",
    payload: { name: "future" },
  });
  createOperationIntake({ database }).apply(
    ownerId,
    "non-session",
    [future],
    ownerId,
    10_000,
  );
  const produced = createOperationProducer({ database }).produce(
    ownerId,
    [workspace("a", "A"), workspace("b", "B")],
    9_000,
  );
  expect(produced.map(({ sequence }) => sequence)).toEqual([51n, 52n]);
  expect(produced[0]?.clock).toEqual({
    physicalMs: 10_000,
    logical: 8,
    writerId: ownerId,
  });
  expect(produced).toHaveLength(2);
  const firstClock = produced[0]?.clock;
  expect(firstClock).toBeDefined();
  if (firstClock === undefined) throw new Error("Missing first produced clock");
  expect(
    compareClocks(produced[1]?.clock ?? firstClock, firstClock),
  ).toBeGreaterThan(0);
  expect(produced[1]?.parents[ownerId]).toBe(51n);
  harness.close();
});

test("producer parent chaining prevents manufactured prompt body conflicts", () => {
  const harness = createOperationDatabaseHarness();
  const { database } = harness.setup();
  const producer = createOperationProducer({ database });
  producer.produce(
    ownerId,
    [
      {
        type: "entity",
        entity: { type: "prompts", id: "prompt" },
        kind: "prompt.create",
        payload: { name: "P", body: "old" },
      },
    ],
    1_000,
  );
  producer.produce(
    ownerId,
    [
      {
        type: "entity",
        entity: { type: "prompts", id: "prompt" },
        kind: "prompt.body.set",
        payload: { value: "new" },
        legacy: { name: "P", body: "old" },
      },
    ],
    1_001,
  );
  const prompt = projection(createOperationStore({ database })).prompts[0];
  expect(prompt?.body?.value).toBe("new");
  expect(prompt?.bodyConflicts).toEqual([]);
  harness.close();
});

test("producer backfills register and entities while deletes remain create-free", () => {
  const harness = createOperationDatabaseHarness();
  const { database } = harness.setup();
  const producer = createOperationProducer({ database });
  producer.produce(
    ownerId,
    [
      {
        type: "account.ensure",
        defaultWorkspace: { id: "default", name: "Default" },
      },
      {
        type: "entity",
        entity: { type: "prompts", id: "legacy-prompt" },
        kind: "prompt.name.set",
        payload: { value: "New" },
        legacy: { name: "Old", body: "Body" },
      },
      {
        type: "entity",
        entity: { type: "workspaces", id: "deleted-only" },
        kind: "workspace.delete",
        payload: {},
      },
    ],
    1_000,
  );
  const value = projection(createOperationStore({ database }));
  expect(value.users[0]).toMatchObject({
    id: ownerId,
    effectiveDefaultWorkspaceId: "default",
  });
  expect(
    value.workspaces.find(({ id }) => id === "default")?.created,
  ).toBeDefined();
  expect(value.prompts[0]).toMatchObject({
    name: { value: "New" },
    body: { value: "Body" },
  });
  const deletedOnly = value.workspaces.find(({ id }) => id === "deleted-only");
  expect(deletedOnly?.created).toBeUndefined();
  expect(deletedOnly?.deleted).toBeDefined();
  harness.close();
});

test("producer failure rolls back its caller transaction", () => {
  const harness = createOperationDatabaseHarness();
  const { database } = harness.setup();
  const intake = createOperationIntake({
    database,
    limits: { ownerPartitionOperations: 1 },
  });
  intake.apply(
    ownerId,
    "non-session",
    [
      createOperation({
        operationId: "first",
        schemaVersion: 1,
        writerId: ownerId,
        sequence: 1n,
        clock: { physicalMs: Date.now(), logical: 0, writerId: ownerId },
        parents: {},
        entity: { type: "workspaces", id: "first", accountId: ownerId },
        kind: "workspace.create",
        payload: { name: "first" },
      }),
    ],
    ownerId,
    Date.now(),
  );
  const producer = createOperationProducer({
    database,
    limits: { ownerPartitionOperations: 1 },
  });
  expect(() =>
    producer.produce(ownerId, [workspace("second", "Second")], Date.now()),
  ).toThrow(/capacity/i);
  expect(
    createOperationStore({ database }).countEnvelopes(ownerId, "non-session"),
  ).toBe(1);
  harness.close();
});

test("producer rejects an encoded operation beyond the envelope bound", () => {
  const harness = createOperationDatabaseHarness();
  const { database } = harness.setup();
  expect(() =>
    createOperationProducer({ database }).produce(
      ownerId,
      [
        {
          type: "entity",
          entity: { type: "prompts", id: "prompt" },
          kind: "prompt.create",
          payload: { name: "P", body: "\0".repeat(44_000) },
        },
      ],
      1_000,
    ),
  ).toThrow(/too large/i);
  harness.close();
});

test("producer envelopes decode canonically", () => {
  const harness = createOperationDatabaseHarness();
  const { database } = harness.setup();
  const operation = createOperationProducer({ database }).produce(
    ownerId,
    [workspace("a", "A")],
    1_000,
  )[0];
  const encoded = createOperationStore({ database }).readEncodedEnvelopes(
    ownerId,
    "non-session",
    {},
    1,
  ).envelopes[0];
  expect(decodeOperationEnvelope(encoded ?? "")).toEqual(operation);
  harness.close();
});
