import { expect, test } from "vitest";
import {
  commandStoreResources,
  type CommandTestDatabase,
} from "./operation-command-test-support";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import { createOperationStore } from "../sync-engine/operation-store";
import { createPromptStore } from "../sync-engine/prompt-store";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "../sync-engine/test/authenticated-integration-test-helpers";
import { createWorkspaceStore } from "../sync-engine/workspace-store";

const operations = (database: CommandTestDatabase) =>
  createOperationStore({ database })
    .readEncodedEnvelopes(TEST_USER_ID, "non-session", {}, 256)
    .envelopes.map(decodeOperationEnvelope);
const projection = (database: CommandTestDatabase) =>
  decodeOperationCheckpoint(
    createOperationStore({ database }).loadCheckpoint(
      TEST_USER_ID,
      "non-session",
    ) ?? "",
    operationEntityProjectionCodec,
  ).projection;

test("first real store command backfills the legacy default register", () => {
  const { database, generateId } = commandStoreResources();
  const legacy = database.query.workspaces.findFirst().sync();
  expect(legacy).toBeDefined();
  createWorkspaceStore(database, generateId).create(
    TEST_USER_ID,
    "Command",
    TEST_NOW + 1,
  );
  expect(projection(database).users[0]).toMatchObject({
    id: TEST_USER_ID,
    effectiveDefaultWorkspaceId: legacy?.id,
  });
  database.$client.close();
});

test("real workspace store emits register, backfill, repair, and nonredundant default operations", () => {
  const { database, generateId } = commandStoreResources();
  const store = createWorkspaceStore(database, generateId);
  const first = store.createDefault(TEST_USER_ID, TEST_NOW);
  const second = store.create(TEST_USER_ID, "Second", TEST_NOW + 1);
  expect(second).toBeDefined();
  store.rename(TEST_USER_ID, second?.id ?? "", "Renamed", TEST_NOW + 2);
  store.setDefault(TEST_USER_ID, second?.id ?? "", TEST_NOW + 3);
  const before = operations(database).length;
  store.setDefault(TEST_USER_ID, second?.id ?? "", TEST_NOW + 4);
  expect(
    operations(database)
      .slice(before)
      .map(({ kind }) => kind),
  ).toEqual(["user.default-workspace.set"]);
  store.remove(TEST_USER_ID, first.id, TEST_NOW + 5);
  expect(projection(database).users[0]?.effectiveDefaultWorkspaceId).toBe(
    second?.id,
  );
  expect(operations(database).map(({ kind }) => kind)).toEqual([
    "workspace.create",
    "user.default-workspace.set",
    "workspace.create",
    "workspace.name.set",
    "user.default-workspace.set",
    "user.default-workspace.set",
    "workspace.delete",
  ]);
  database.$client.close();
});

test("real prompt store emits changed fields only and delete", () => {
  const { database, generateId } = commandStoreResources();
  const workspace = createWorkspaceStore(database, generateId).createDefault(
    TEST_USER_ID,
    TEST_NOW,
  );
  expect(workspace.id).toBeDefined();
  const store = createPromptStore(database, generateId);
  const prompt = store.create(
    TEST_USER_ID,
    { name: "One", body: "Body" },
    TEST_NOW + 1,
  );
  const afterCreate = operations(database).length;
  const name = store.update(
    TEST_USER_ID,
    prompt.id,
    { name: "Two", body: "Body" },
    TEST_NOW + 2,
    1,
  );
  const body = store.update(
    TEST_USER_ID,
    prompt.id,
    { body: "Next", name: name?.name ?? "Two" },
    TEST_NOW + 3,
    name?.revision ?? 2,
  );
  const unchangedBefore = operations(database).length;
  const unchangedInput = {
    name: body?.name ?? "Two",
    body: body?.body ?? "Next",
  };
  const unchanged = store.update(
    TEST_USER_ID,
    prompt.id,
    unchangedInput,
    TEST_NOW + 4,
    body?.revision ?? 3,
  );
  expect(operations(database)).toHaveLength(unchangedBefore);
  store.remove(TEST_USER_ID, prompt.id, TEST_NOW + 5, unchanged?.revision ?? 4);
  expect(
    operations(database)
      .slice(afterCreate)
      .map(({ kind }) => kind),
  ).toEqual(["prompt.name.set", "prompt.body.set", "prompt.delete"]);
  database.$client.close();
});

test("store commands roll back legacy rows when operation capacity fails", () => {
  const { database, generateId } = commandStoreResources();
  const workspaceStore = createWorkspaceStore(database, generateId, {
    ownerPartitionOperations: 0,
  });
  const beforeWorkspaces = database.query.workspaces.findMany().sync();
  expect(() =>
    workspaceStore.create(TEST_USER_ID, "Rollback", TEST_NOW),
  ).toThrow(/capacity/i);
  expect(database.query.workspaces.findMany().sync()).toEqual(beforeWorkspaces);
  const promptStore = createPromptStore(database, generateId, undefined, {
    ownerPartitionOperations: 0,
  });
  expect(() =>
    promptStore.create(
      TEST_USER_ID,
      { name: "Rollback", body: "Body" },
      TEST_NOW,
    ),
  ).toThrow(/capacity/i);
  expect(database.query.prompts.findMany().sync()).toEqual([]);
  database.$client.close();
});
