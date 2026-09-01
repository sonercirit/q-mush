import { Database } from "bun:sqlite";
import { expect, test } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store";
import {
  decodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { createOperation } from "../shared/operation-core";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import { createOperationStore } from "../sync-engine/operation-store";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization";
import { createPromptStore } from "../sync-engine/prompt-store";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "../sync-engine/test/authenticated-integration-test-helpers";
import { createWorkspaceStore } from "../sync-engine/workspace-store";
import { commandStoreResources } from "./operation-command-test-support";

type CommandResources = ReturnType<typeof commandStoreResources>;
const operationStore = (database: CommandResources["database"]) =>
  createOperationStore({ database });
const engineCheckpoint = (database: CommandResources["database"]) => {
  const store = operationStore(database);
  return decodeOperationCheckpoint(
    store.loadCheckpoint(TEST_USER_ID, "non-session") ?? "",
    operationEntityProjectionCodec,
  );
};
const replicaProjection = (database: CommandResources["database"]) => {
  const store = operationStore(database);
  const page = store.readEncodedEnvelopes(TEST_USER_ID, "non-session", {}, 256);
  const replicaDatabase = new Database(":memory:");
  try {
    const replica = createRunnerOperationStore(replicaDatabase);
    replica.apply(TEST_USER_ID, "non-session", page.envelopes, "remote");
    return replica.state(TEST_USER_ID, "non-session").projection;
  } finally {
    replicaDatabase.close();
  }
};
const workspaceResources = () => {
  const resources = commandStoreResources();
  return {
    resources,
    workspaces: createWorkspaceStore(resources.database, resources.generateId),
  };
};
const devicePushRequest = (envelope: string): Request => {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  return new Request("http://localhost/api/operations/synchronize", {
    body: JSON.stringify({
      envelopes: [envelope],
      ownerId: "self",
      partition: "non-session",
    }),
    headers,
    method: "POST",
  });
};

test("engine and device writers converge through the merged log", async () => {
  const { resources, workspaces } = workspaceResources();
  const defaultWorkspace = workspaces.createDefault(TEST_USER_ID, TEST_NOW);
  expect(defaultWorkspace.id).toBeDefined();
  const second = workspaces.create(TEST_USER_ID, "Device target", TEST_NOW + 1);
  if (second === undefined) throw new Error("Missing device target workspace");
  const beforeDevice = engineCheckpoint(resources.database);
  const runnerId = "018bcfe5-6800-7000-8000-000000000099";
  const deviceOperation = createOperation({
    operationId: "device-default",
    schemaVersion: 1,
    writerId: runnerId,
    sequence: 1n,
    clock: { physicalMs: Date.now(), logical: 0, writerId: runnerId },
    parents: beforeDevice.frontier,
    entity: { type: "users", id: TEST_USER_ID, accountId: TEST_USER_ID },
    kind: "user.default-workspace.set",
    payload: { defaultWorkspaceId: second.id },
  });
  const synchronize = createOperationSynchronization(resources.database, {
    runnerAccount: () => ({ runnerId, userId: TEST_USER_ID }),
  });
  const pushed = await synchronize(
    devicePushRequest(encodeOperationEnvelope(deviceOperation)),
  );
  expect(pushed.status).toBe(200);
  const engine = engineCheckpoint(resources.database);
  expect(replicaProjection(resources.database)).toEqual(engine.projection);
  expect(engine.frontier).toMatchObject({
    [TEST_USER_ID]: 3n,
    [runnerId]: 1n,
  });
  expect(engine.projection.users[0]?.effectiveDefaultWorkspaceId).toBe(
    second.id,
  );
  resources.database.$client.close();
});

test("engine command envelopes converge to the same runner projection", () => {
  const { resources, workspaces } = workspaceResources();
  const first = workspaces.createDefault(TEST_USER_ID, TEST_NOW);
  const second = workspaces.create(TEST_USER_ID, "Second", TEST_NOW + 1);
  if (second === undefined) throw new Error("Missing second workspace");
  workspaces.rename(TEST_USER_ID, second.id, "Renamed", TEST_NOW + 2);
  workspaces.remove(TEST_USER_ID, first.id, TEST_NOW + 3);
  const prompts = createPromptStore(resources.database, resources.generateId);
  const prompt = prompts.create(
    TEST_USER_ID,
    { name: "Prompt", body: "Old" },
    TEST_NOW + 4,
  );
  prompts.update(
    TEST_USER_ID,
    prompt.id,
    { name: "Prompt", body: "New" },
    TEST_NOW + 5,
    1,
  );
  const engine = engineCheckpoint(resources.database);
  const replica = replicaProjection(resources.database);
  expect(replica).toEqual(engine.projection);
  expect(replica.users[0]?.effectiveDefaultWorkspaceId).toBe(second.id);
  resources.database.$client.close();
});
