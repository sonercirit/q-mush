import { expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { compareClocks } from "../shared/operation-core";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import { createOperationIntake } from "../sync-engine/operation-intake";
import {
  createOperationProducer,
  operationAccountIntent,
  operationEntityIntent,
} from "../sync-engine/operation-producer";
import { createOperationStore } from "../sync-engine/operation-store";
import { promptBodySet } from "./operation-producer-intent-test-support";
import {
  operationDatabase,
  producerOperation,
  producerPrompt,
  producerWorkspace,
} from "./operation-producer-test-support";

const ownerId = "owner-1";
const projection = (store: ReturnType<typeof createOperationStore>) =>
  decodeOperationCheckpoint(
    store.loadCheckpoint(ownerId, "non-session") ?? "",
    operationEntityProjectionCodec,
  ).projection;

test("producer mints past a stored future sequence and chains clocks and parents", () => {
  const { harness, database } = operationDatabase();
  const future = producerOperation(ownerId, "future", 50n, 10_000, 7);
  createOperationIntake({ database }).apply(
    ownerId,
    "non-session",
    [future],
    ownerId,
    10_000,
  );
  const produced = createOperationProducer({ database }).produce(
    ownerId,
    [producerWorkspace("a", "A"), producerWorkspace("b", "B")],
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
  const resources = operationDatabase();
  const producer = createOperationProducer({ database: resources.database });
  const initialPrompt = producerPrompt("prompt", "old");
  const createdOperations = producer.produce(ownerId, [initialPrompt], 1_000);
  expect(createdOperations).toHaveLength(1);
  producer.produce(
    ownerId,
    [promptBodySet("middle", "old"), promptBodySet("new", "middle")],
    1_001,
  );
  const prompt = decodeOperationCheckpoint(
    createOperationStore({ database: resources.database }).loadCheckpoint(
      ownerId,
      "non-session",
    ) ?? "",
    operationEntityProjectionCodec,
  ).projection.prompts[0];
  expect(prompt?.body?.value).toBe("new");
  expect(prompt?.bodyConflicts).toEqual([]);
  resources.harness.close();
});

test("producer backfills register and entities while deletes remain create-free", () => {
  const { harness, database } = operationDatabase();
  const producer = createOperationProducer({ database });
  producer.produce(
    ownerId,
    [
      operationAccountIntent({ id: "default", name: "Default" }),
      operationEntityIntent(
        "prompts",
        "legacy-prompt",
        "prompt.name.set",
        { value: "New" },
        { name: "Old", body: "Body" },
      ),
      operationEntityIntent(
        "workspaces",
        "deleted-only",
        "workspace.delete",
        {},
      ),
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
  const { harness, database } = operationDatabase();
  const intake = createOperationIntake({
    database,
    limits: { ownerPartitionOperations: 1 },
  });
  intake.apply(
    ownerId,
    "non-session",
    [producerOperation(ownerId, "first", 1n, Date.now())],
    ownerId,
    Date.now(),
  );
  const producer = createOperationProducer({
    database,
    limits: { ownerPartitionOperations: 1 },
  });
  expect(() =>
    producer.produce(
      ownerId,
      [producerWorkspace("second", "Second")],
      Date.now(),
    ),
  ).toThrow(/capacity/i);
  expect(
    createOperationStore({ database }).countEnvelopes(ownerId, "non-session"),
  ).toBe(1);
  harness.close();
});

test("producer rejects an encoded operation beyond the envelope bound", () => {
  const { harness, database } = operationDatabase();
  expect(() =>
    createOperationProducer({ database }).produce(
      ownerId,
      [producerPrompt("prompt", "\0".repeat(44_000))],
      1_000,
    ),
  ).toThrow(/too large/i);
  harness.close();
});

test("producer envelopes decode canonically", () => {
  const { harness, database } = operationDatabase();
  const operation = createOperationProducer({ database }).produce(
    ownerId,
    [producerWorkspace("a", "A")],
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
