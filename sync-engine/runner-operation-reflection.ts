import { eq } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { workspaces } from "../shared/database/schema.ts";
import {
  operationProtocolError,
  type Operation,
} from "../shared/operation-core.ts";
import type { OperationEntityProjection } from "../shared/operation-projection.ts";
import { legacyDefaultOperationIntent } from "./operation-producer-backfill.ts";
import {
  createOperationProducer,
  operationEntityEnsureIntent,
  type OperationProducerIntent,
} from "./operation-producer.ts";

const touchedWorkspaceIds = (
  operations: readonly Operation[],
): readonly string[] => [...new Set(operations.map(({ entity }) => entity.id))];

const legacyWorkspace = (database: AppDatabase, ownerId: string, id: string) =>
  database.query.workspaces
    .findFirst({
      columns: { isDefault: true, name: true },
      where: (workspace, { and, eq: equal }) =>
        and(equal(workspace.userId, ownerId), equal(workspace.id, id)),
    })
    .sync();

export const assertReflectableRunnerOperations = (
  operations: readonly Operation[],
): void => {
  if (operations.some(({ entity }) => entity.type !== "workspaces"))
    throw operationProtocolError(
      "invalid",
      "Runner-authored operation entity kind is not reflectable",
    );
};

const backfillTime = (operations: readonly Operation[], now: number): number =>
  Math.min(
    now,
    ...operations.map(({ clock }) => Math.max(0, clock.physicalMs - 1)),
  );

export const backfillRunnerWorkspaceOperations = (
  database: AppDatabase,
  ownerId: string,
  operations: readonly Operation[],
  now: number,
): void => {
  const intents: OperationProducerIntent[] = [
    legacyDefaultOperationIntent(database, ownerId),
  ];
  for (const id of touchedWorkspaceIds(operations)) {
    const legacy = legacyWorkspace(database, ownerId, id);
    if (legacy !== undefined)
      intents.push(operationEntityEnsureIntent("workspaces", id, legacy));
  }
  createOperationProducer({ database }).produce(
    ownerId,
    intents,
    backfillTime(operations, now),
  );
};

export const reflectRunnerWorkspaceOperations = (
  database: AppDatabase,
  ownerId: string,
  operations: readonly Operation[],
  projection: OperationEntityProjection,
  now: number,
): void => {
  for (const id of touchedWorkspaceIds(operations)) {
    const projected = projection.workspaces.find(
      (workspace) => workspace.id === id,
    );
    if (projected?.created === undefined || projected.name === undefined)
      continue;
    const existing = legacyWorkspace(database, ownerId, id);
    database
      .insert(workspaces)
      .values({
        ...createdAuditFields(ownerId, now),
        id,
        isDefault: existing?.isDefault ?? false,
        isDeleted: projected.deleted !== undefined,
        name: projected.name.value,
        userId: ownerId,
      })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          ...updatedAuditFields(ownerId, now),
          isDeleted: projected.deleted !== undefined,
          name: projected.name.value,
        },
        where: eq(workspaces.userId, ownerId),
      })
      .run();
  }
};
