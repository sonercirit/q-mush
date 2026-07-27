import { and, eq, not } from "drizzle-orm";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "./audit.ts";
import type { AppDatabase } from "./database.ts";
import {
  runners,
  workspaces,
  type providerCredentials,
  type providerCredentialWorkspaces,
  type runnerWorkspaces,
} from "./database/schema.ts";
import type { IdGenerator } from "./ids.ts";
import { GLOBAL_WORKSPACE_ID, isWorkspaceId } from "./workspace-model.ts";

type ScopeDatabase =
  AppDatabase | Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
type ScopeOwnerTable = typeof providerCredentials | typeof runners;
type ScopeAssociationTable =
  typeof providerCredentialWorkspaces | typeof runnerWorkspaces;

export interface ConnectionScopeConfiguration {
  readonly associationTable: ScopeAssociationTable;
  readonly generateId: IdGenerator;
  readonly ownerIdColumn:
    | typeof providerCredentialWorkspaces.providerCredentialId
    | typeof runnerWorkspaces.runnerId;
  readonly ownerTable: ScopeOwnerTable;
}

export interface ConnectionScopes {
  readonly isGlobal: boolean;
  readonly workspaceIds: readonly string[];
}

function activeScopeCondition(
  configuration: ConnectionScopeConfiguration,
  userId: string,
  ownerId: string,
) {
  return and(
    eq(configuration.associationTable.userId, userId),
    eq(configuration.ownerIdColumn, ownerId),
    not(configuration.associationTable.isDeleted),
  );
}

function activeWorkspaceCondition(userId: string, workspaceId?: string) {
  const ownerCondition = and(
    eq(workspaces.userId, userId),
    not(workspaces.isDeleted),
  );
  return workspaceId === undefined
    ? ownerCondition
    : and(ownerCondition, eq(workspaces.id, workspaceId));
}

function activeWorkspaceIdsQuery(
  database: Pick<AppDatabase, "select">,
  userId: string,
  workspaceId?: string,
) {
  const selection = database.select({ id: workspaces.id });
  return selection
    .from(workspaces)
    .where(activeWorkspaceCondition(userId, workspaceId));
}

function ownedWorkspaceIds(
  database: Pick<AppDatabase, "select">,
  userId: string,
): readonly string[] {
  return activeWorkspaceIdsQuery(database, userId)
    .all()
    .map(({ id }) => id);
}

export function connectionWorkspaceIsAvailable(
  database: AppDatabase,
  userId: string,
  workspaceId: string,
): boolean {
  if (!isWorkspaceId(workspaceId)) {
    return false;
  }
  return (
    workspaceId === GLOBAL_WORKSPACE_ID ||
    activeWorkspaceIdsQuery(database, userId, workspaceId).get() !== undefined
  );
}

export function validateConnectionScopes(
  database: AppDatabase,
  userId: string,
  workspaceIds: readonly string[],
): readonly string[] {
  const scopes = [...new Set(workspaceIds)];
  if (
    scopes.length === 0 ||
    scopes.length !== workspaceIds.length ||
    !scopes.every(isWorkspaceId)
  ) {
    throw new Error("A connection workspace is invalid");
  }
  const ordinaryIds = scopes.filter((id) => id !== GLOBAL_WORKSPACE_ID);

  const ownedIds = ownedWorkspaceIds(database, userId);
  if (!ordinaryIds.every((id) => ownedIds.includes(id))) {
    throw new Error("A connection workspace is unavailable");
  }
  return scopes.includes(GLOBAL_WORKSPACE_ID)
    ? [GLOBAL_WORKSPACE_ID]
    : ordinaryIds;
}

export function readConnectionScopes(
  database: AppDatabase,
  configuration: ConnectionScopeConfiguration,
  userId: string,
  ownerId: string,
): readonly string[] {
  return database
    .select({ workspaceId: configuration.associationTable.workspaceId })
    .from(configuration.associationTable)
    .where(activeScopeCondition(configuration, userId, ownerId))
    .orderBy(
      configuration.associationTable.createdAt,
      configuration.associationTable.id,
    )
    .all()
    .map(({ workspaceId }) => workspaceId);
}

export function replaceConnectionScopes(
  database: ScopeDatabase,
  configuration: ConnectionScopeConfiguration,
  userId: string,
  ownerId: string,
  workspaceIds: readonly string[],
  now: number,
): void {
  const desired = new Set(
    workspaceIds.filter((id) => id !== GLOBAL_WORKSPACE_ID),
  );
  const stored = database
    .select({
      id: configuration.associationTable.id,
      isDeleted: configuration.associationTable.isDeleted,
      workspaceId: configuration.associationTable.workspaceId,
    })
    .from(configuration.associationTable)
    .where(
      and(
        eq(configuration.ownerIdColumn, ownerId),
        eq(configuration.associationTable.userId, userId),
      ),
    )
    .all();
  for (const scope of stored) {
    const shouldBeActive = desired.delete(scope.workspaceId);
    if (shouldBeActive === scope.isDeleted) {
      database
        .update(configuration.associationTable)
        .set(
          shouldBeActive
            ? { isDeleted: false, ...updatedAuditFields(userId, now) }
            : softDeletedAuditFields(userId, now),
        )
        .where(eq(configuration.associationTable.id, scope.id))
        .run();
    }
  }
  for (const workspaceId of desired) {
    const association = {
      ...createdAuditFields(userId, now),
      id: configuration.generateId(now),
      userId,
      workspaceId,
      ...(configuration.ownerTable === runners
        ? { runnerId: ownerId }
        : { providerCredentialId: ownerId }),
    };
    database.insert(configuration.associationTable).values(association).run();
  }
}

export function removeConnectionScopes(
  database: ScopeDatabase,
  configuration: ConnectionScopeConfiguration,
  userId: string,
  ownerId: string,
  now: number,
): void {
  database
    .update(configuration.associationTable)
    .set(softDeletedAuditFields(userId, now))
    .where(activeScopeCondition(configuration, userId, ownerId))
    .run();
}

export function connectionIsAccessible(
  scopes: ConnectionScopes,
  workspaceId: string | undefined,
): boolean {
  return (
    workspaceId === undefined ||
    scopes.isGlobal ||
    (workspaceId !== GLOBAL_WORKSPACE_ID &&
      scopes.workspaceIds.includes(workspaceId))
  );
}
