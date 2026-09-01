import { expect, test } from "vitest";
import {
  decodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { createOperation, type Operation } from "../shared/operation-core";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import { OPERATION_SYNCHRONIZATION_PATH } from "../shared/routes";
import { createOperationStore } from "../sync-engine/operation-store";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization";
import {
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "../sync-engine/test/authenticated-integration-test-helpers";
import { createWorkspaceStore } from "../sync-engine/workspace-store";
import { insertWorkspace } from "../sync-engine/workspace-write";

const ownerId = TEST_USER_ID;
const runnerId = "reflection-runner";
const endpoint = `http://localhost${OPERATION_SYNCHRONIZATION_PATH}`;
const reflectedId = "workspace-reflected";
const operationNow = Date.now();
const workspaceOperation = (
  sequence: bigint,
  kind: "workspace.create" | "workspace.delete" | "workspace.name.set",
  payload: unknown,
  parents: Readonly<Record<string, bigint>> = {},
  clock = operationNow,
  id = reflectedId,
): Operation =>
  createOperation({
    operationId: `runner-${sequence.toString()}`,
    schemaVersion: 1,
    writerId: runnerId,
    sequence,
    clock: { physicalMs: clock, logical: Number(sequence), writerId: runnerId },
    parents,
    entity: { accountId: ownerId, id, type: "workspaces" },
    kind,
    payload,
  });
const promptOperation = (): Operation =>
  createOperation({
    operationId: "prompt-1",
    schemaVersion: 1,
    writerId: runnerId,
    sequence: 2n,
    clock: { physicalMs: operationNow, logical: 2, writerId: runnerId },
    parents: { [runnerId]: 1n },
    entity: { accountId: ownerId, id: "prompt-reflected", type: "prompts" },
    kind: "prompt.create",
    payload: { name: "Prompt", body: "Body" },
  });
const synchronizationRequest = (operations: readonly Operation[]) => {
  const payload = {
    ownerId: "self",
    partition: "non-session",
    envelopes: operations.map(encodeOperationEnvelope),
  } as const;
  return new Request(endpoint, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: new Headers([["content-type", "application/json"]]),
  });
};
const setup = () => {
  const database = createAuthenticatedTestDatabase();
  const synchronized = createOperationSynchronization(database, {
    runnerAccount: () => ({ runnerId, userId: ownerId }),
  });
  const push = (operations: readonly Operation[]) =>
    synchronized(synchronizationRequest(operations));
  return { database, push };
};
type TestDatabase = ReturnType<typeof setup>["database"];
const checkpoint = (database: TestDatabase) => {
  const encoded = createOperationStore({ database }).loadCheckpoint(
    ownerId,
    "non-session",
  );
  return encoded === undefined
    ? undefined
    : decodeOperationCheckpoint(encoded, operationEntityProjectionCodec);
};
const reflectedRow = (database: TestDatabase) =>
  database.query.workspaces
    .findFirst({
      where: (workspace, { eq }) => eq(workspace.id, reflectedId),
    })
    .sync();
const projectionWorkspace = (database: TestDatabase) =>
  checkpoint(database)?.projection.workspaces.find(
    ({ id }) => id === reflectedId,
  );
const insertLegacyReflectedWorkspace = (database: TestDatabase): void => {
  insertWorkspace(database, {
    id: reflectedId,
    name: "Legacy",
    now: TEST_NOW,
    userId: ownerId,
  });
};
const close = (database: TestDatabase): void => {
  database.$client.close();
};
const expectListedWorkspace = (database: TestDatabase, name: string): void => {
  expect(
    createWorkspaceStore(database).list(ownerId).workspaces,
  ).toContainEqual({
    id: reflectedId,
    isDefault: false,
    name,
  });
};
const expectWorkspacePushStatus = async (
  push: ReturnType<typeof setup>["push"],
  operation: Operation,
  status: number,
): Promise<void> => {
  expect((await push([operation])).status).toBe(status);
};
const expectPush = async (
  push: ReturnType<typeof setup>["push"],
  operation: Operation,
) => expectWorkspacePushStatus(push, operation, 200);

test("runner create rename and delete are visible through workspace listing with audit soft-delete", async () => {
  const { database, push } = setup();
  const create = workspaceOperation(1n, "workspace.create", { name: "One" });
  await expectPush(push, create);
  expectListedWorkspace(database, "One");
  expect(reflectedRow(database)).toMatchObject({
    createdById: ownerId,
    isDeleted: false,
    name: "One",
    updatedById: ownerId,
  });

  await expectPush(
    push,
    workspaceOperation(
      2n,
      "workspace.name.set",
      { value: "Two" },
      { [runnerId]: 1n },
    ),
  );
  expectListedWorkspace(database, "Two");

  await expectPush(
    push,
    workspaceOperation(3n, "workspace.delete", {}, { [runnerId]: 2n }),
  );
  expect(
    createWorkspaceStore(database)
      .list(ownerId)
      .workspaces.map(({ id }) => id),
  ).not.toContain(reflectedId);
  const row = reflectedRow(database);
  expect(row).toMatchObject({
    createdById: ownerId,
    isDeleted: true,
    name: "Two",
    updatedById: ownerId,
  });
  expect(row?.createdAt).toBeInstanceOf(Date);
  expect(row?.updatedAt).toBeInstanceOf(Date);
  expect(projectionWorkspace(database)?.name?.value).toBe(row?.name);
  expect(projectionWorkspace(database)?.deleted !== undefined).toBe(
    row?.isDeleted,
  );
  database.$client.close();
});

test("runner rename first-touch backfills a legacy workspace and preserves later engine commands", async () => {
  const { database, push } = setup();
  insertLegacyReflectedWorkspace(database);

  await expectPush(
    push,
    workspaceOperation(1n, "workspace.name.set", { value: "Runner rename" }),
  );
  expect(reflectedRow(database)?.name).toBe("Runner rename");
  const projected = checkpoint(database)?.projection;
  expect(projected?.users[0]?.effectiveDefaultWorkspaceId).toBe(
    TEST_WORKSPACE_ID,
  );
  expect(projectionWorkspace(database)?.created).toBeDefined();

  const renamed = createWorkspaceStore(database).rename(
    ownerId,
    reflectedId,
    "Engine rename",
    operationNow + 1,
  );
  expect(renamed?.name).toBe("Engine rename");
  expect(reflectedRow(database)?.name).toBe("Engine rename");
  expect(projectionWorkspace(database)?.name?.value).toBe("Engine rename");
  database.$client.close();
});

test("mixed reflectable and unsupported batch fails atomically before all persistence", async () => {
  const { database, push } = setup();
  const store = createOperationStore({ database });
  const checkpointBefore = store.loadCheckpoint(ownerId, "non-session");
  const envelopesBefore = store.readEncodedEnvelopes(
    ownerId,
    "non-session",
    {},
    100,
  ).envelopes;
  const legacyBefore = database.query.workspaces.findMany().sync();

  expect(
    (
      await push([
        workspaceOperation(1n, "workspace.create", { name: "No" }),
        promptOperation(),
      ])
    ).status,
  ).toBe(400);
  expect(store.loadCheckpoint(ownerId, "non-session")).toBe(checkpointBefore);
  expect(
    store.readEncodedEnvelopes(ownerId, "non-session", {}, 100).envelopes,
  ).toEqual(envelopesBefore);
  expect(checkpoint(database)?.projection).toEqual(
    checkpointBefore === undefined
      ? undefined
      : decodeOperationCheckpoint(
          checkpointBefore,
          operationEntityProjectionCodec,
        ).projection,
  );
  const legacyAfter = database.query.workspaces.findMany().sync();
  expect(legacyAfter).toEqual(legacyBefore);
  database.$client.close();
});

test("legacy reflection failure rolls back envelope checkpoint and projection", async () => {
  const { database, push } = setup();
  database.$client.run(`
    CREATE TRIGGER reject_reflected_workspace
    BEFORE INSERT ON workspaces
    WHEN NEW.id = '${reflectedId}'
    BEGIN SELECT RAISE(ABORT, 'reflection rejected'); END
  `);
  const response = await push([
    workspaceOperation(1n, "workspace.create", { name: "Owned" }),
  ]);
  expect(response.status).toBe(500);
  const store = createOperationStore({ database });
  expect(store.loadCheckpoint(ownerId, "non-session")).toBeUndefined();
  expect(
    store.readEncodedEnvelopes(ownerId, "non-session", {}, 10).envelopes,
  ).toEqual([]);
  expect(reflectedRow(database)).toBeUndefined();
  close(database);
});

const runPriorClockProbe = () => {
  const context = setup();
  insertLegacyReflectedWorkspace(context.database);
  return context;
};

test("prior engine clock cannot erase an older runner rename of a legacy-only workspace", async () => {
  const { database, push } = runPriorClockProbe();
  expect(
    createWorkspaceStore(database).rename(
      ownerId,
      TEST_WORKSPACE_ID,
      "Engine default",
      operationNow,
    ),
  ).toBeDefined();
  await expectWorkspacePushStatus(
    push,
    workspaceOperation(
      1n,
      "workspace.name.set",
      { value: "Runner wins" },
      {},
      operationNow - 100,
    ),
    200,
  );
  expect(projectionWorkspace(database)?.name?.value).toBe("Runner wins");
  expect(reflectedRow(database)?.name).toBe("Runner wins");
  database.$client.close();
});

test("runner deleting the default deterministically reassigns a surviving default", async () => {
  const { database, push } = setup();
  expect(
    createWorkspaceStore(database, () => reflectedId).create(
      ownerId,
      "Survivor",
      TEST_NOW + 1,
    ),
  ).toBeDefined();
  await expectWorkspacePushStatus(
    push,
    workspaceOperation(
      1n,
      "workspace.delete",
      {},
      {},
      operationNow,
      TEST_WORKSPACE_ID,
    ),
    200,
  );
  const listed = createWorkspaceStore(database).list(ownerId);
  expect(listed.defaultWorkspaceId).toBe(reflectedId);
  expect(listed.workspaces.filter(({ isDefault }) => isDefault)).toHaveLength(
    1,
  );
  close(database);
});

test("runner workspace names fail closed without normalization while duplicates converge", async () => {
  for (const name of ["", "   ", "x".repeat(101), "GLOBAL"]) {
    const { database, push } = setup();
    const response = await push([
      workspaceOperation(1n, "workspace.create", { name }),
    ]);
    expect(response.status).toBe(400);
    expect(reflectedRow(database)).toBeUndefined();
    database.$client.close();
  }
  const { database, push } = setup();
  const valid = workspaceOperation(1n, "workspace.create", { name: "Default" });
  await expectPush(push, valid);
  expect(reflectedRow(database)).toMatchObject({ name: "Default" });
  close(database);
});

const convergedResult = async (runnerFirst: boolean) => {
  const context = setup();
  const database = context.database;
  const push = context.push;
  const workspaces = createWorkspaceStore(database, () => reflectedId);
  workspaces.create(ownerId, "Initial", TEST_NOW + 1);
  const runnerRename = workspaceOperation(
    1n,
    "workspace.name.set",
    { value: "Runner" },
    {},
    operationNow - 100,
  );
  if (runnerFirst) await expectPush(push, runnerRename);
  expect(
    workspaces.rename(ownerId, reflectedId, "Engine", operationNow + 1)?.name,
  ).toBe("Engine");
  if (!runnerFirst) await expectPush(push, runnerRename);
  const result = {
    legacy: reflectedRow(database),
    projected: projectionWorkspace(database),
  };
  database.$client.close();
  return result;
};

test("concurrent engine and runner workspace operations converge in either arrival order", async () => {
  const runnerThenEngine = await convergedResult(true);
  const engineThenRunner = await convergedResult(false);
  expect(runnerThenEngine.projected?.name?.value).toBe(
    engineThenRunner.projected?.name?.value,
  );
  expect(runnerThenEngine.projected?.deleted).toEqual(
    engineThenRunner.projected?.deleted,
  );
  expect(runnerThenEngine.legacy?.name).toBe("Engine");
  expect(engineThenRunner.legacy?.name).toBe("Engine");
  for (const result of [runnerThenEngine, engineThenRunner]) {
    const projected = result.projected;
    expect(result.legacy?.name).toBe(projected?.name?.value);
    expect(result.legacy?.isDeleted).toBe(projected?.deleted !== undefined);
  }
});
