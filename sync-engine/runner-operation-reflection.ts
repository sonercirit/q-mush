import { and, eq } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { workspaces } from "../shared/database/schema.ts";
import { decodeOperationCheckpoint } from "../shared/operation-checkpoint.ts";
import {
  operationProtocolError,
  type Operation,
} from "../shared/operation-core.ts";
import {
  initialOperationEntityProjection,
  operationEntityProjectionCodec,
  type OperationEntityProjection,
} from "../shared/operation-projection.ts";
import { isRecord } from "../shared/validation.ts";
import { normalizeWorkspaceName } from "../shared/workspace-model.ts";
import { legacyDefaultOperationIntent } from "./operation-producer-backfill.ts";
import {
  createOperationProducer,
  operationEntityEnsureIntent,
  type OperationProducerIntent,
} from "./operation-producer.ts";
import { createOperationStore } from "./operation-store.ts";

const touchedWorkspaceIds = (
  operations: readonly Operation[],
): readonly string[] => [
  ...new Set(
    operations
      .filter(({ entity }) => entity.type === "workspaces")
      .map(({ entity }) => entity.id),
  ),
];

const legacyWorkspace = (database: AppDatabase, ownerId: string, id: string) =>
  database
    .select({ isDefault: workspaces.isDefault, name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.userId, ownerId), eq(workspaces.id, id)))
    .get();

const projectionFor = (
  database: AppDatabase,
  ownerId: string,
): OperationEntityProjection => {
  const store = createOperationStore({ database });
  const encoded = store.loadCheckpoint(ownerId, "non-session");
  return encoded === undefined
    ? initialOperationEntityProjection
    : decodeOperationCheckpoint(encoded, operationEntityProjectionCodec)
        .projection;
};

const reflectedName = (operation: Operation): string | undefined => {
  const payload = operation.payload;
  if (!isRecord(payload)) return undefined;
  const key =
    operation.kind === "workspace.create"
      ? "name"
      : operation.kind === "workspace.name.set"
        ? "value"
        : undefined;
  const value = key === undefined ? undefined : payload[key];
  return typeof value === "string" ? value : undefined;
};

export const assertReflectableRunnerOperations = (
  operations: readonly Operation[],
): void => {
  for (const operation of operations) {
    const reflectable =
      operation.entity.type === "workspaces" ||
      (operation.entity.type === "users" &&
        operation.kind === "user.default-workspace.set");
    const name = reflectedName(operation);
    if (!reflectable)
      throw operationProtocolError(
        "invalid",
        "Runner-authored operation entity kind is not reflectable",
      );
    if (name !== undefined && normalizeWorkspaceName(name) !== name)
      throw operationProtocolError("invalid", "Workspace name is invalid");
  }
};

export const backfillRunnerWorkspaceOperations = (
  database: AppDatabase,
  ownerId: string,
  operations: readonly Operation[],
  now: number,
): void => {
  const projection = projectionFor(database, ownerId);
  const intents: OperationProducerIntent[] = [];
  if (
    !projection.users.some(({ id }) => id === ownerId) &&
    database.query.workspaces
      .findFirst({
        columns: { id: true },
        where: (workspace, { and: all, eq: equal }) =>
          all(
            equal(workspace.userId, ownerId),
            equal(workspace.isDefault, true),
          ),
      })
      .sync() !== undefined
  )
    intents.push(legacyDefaultOperationIntent(database, ownerId));
  for (const id of touchedWorkspaceIds(operations)) {
    const projected = projection.workspaces.find((item) => item.id === id);
    const legacy = legacyWorkspace(database, ownerId, id);
    if (legacy !== undefined && projected === undefined)
      intents.push(operationEntityEnsureIntent("workspaces", id, legacy));
  }
  if (intents.length > 0)
    createOperationProducer({ database }).produce(ownerId, intents, now);
};

export const reflectRunnerWorkspaceOperations = (
  database: AppDatabase,
  ownerId: string,
  _operations: readonly Operation[],
  projection: OperationEntityProjection,
  now: number,
): void => {
  const active = projection.workspaces.filter(
    (workspace) =>
      workspace.created !== undefined && workspace.deleted === undefined,
  );
  const projectedDefault = projection.users.find(
    ({ id }) => id === ownerId,
  )?.effectiveDefaultWorkspaceId;
  const defaultId = active.some(({ id }) => id === projectedDefault)
    ? projectedDefault
    : (active[0]?.id ?? null);
  database
    .update(workspaces)
    .set({ isDefault: false })
    .where(and(eq(workspaces.userId, ownerId), eq(workspaces.isDefault, true)))
    .run();
  for (const projected of projection.workspaces) {
    if (projected.created === undefined || projected.name === undefined)
      continue;
    const reflectedValues = {
      isDefault: projected.id === defaultId,
      isDeleted: projected.deleted !== undefined,
      name: projected.name.value,
    };
    database
      .insert(workspaces)
      .values({
        ...createdAuditFields(ownerId, now),
        id: projected.id,
        ...reflectedValues,
        userId: ownerId,
      })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          ...updatedAuditFields(ownerId, now),
          ...reflectedValues,
        },
        where: eq(workspaces.userId, ownerId),
      })
      .run();
  }
};
