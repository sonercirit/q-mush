import { and, asc, eq, ne, not, type SQL } from "drizzle-orm";
import { softDeletedAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentSessions,
  providerCredentials,
  providerCredentialWorkspaces,
  runners,
  runnerWorkspaces,
  workspaces,
} from "../shared/database/schema.ts";
import { defaultValues } from "../shared/default-store.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { isOperationProtocolError } from "../shared/operation-core.ts";
import {
  DEFAULT_WORKSPACE_NAME,
  GLOBAL_WORKSPACE_ID,
  type WorkspaceList,
  type WorkspaceSummary,
} from "../shared/workspace-model.ts";

import { commandOperationProducer } from "./command-operation-producer.ts";
import { activeCredentialWorkspaceCondition } from "./credential-workspace-query.ts";
import type { OperationIntakeLimits } from "./operation-intake.ts";
import { legacyDefaultOperationIntent } from "./operation-producer-backfill.ts";
import {
  operationEntityEnsureIntent,
  operationEntityIntent,
} from "./operation-producer.ts";
import { insertWorkspaceWithOperation } from "./workspace-command-create.ts";
import {
  defaultWorkspaceCondition,
  setWorkspaceDefault,
} from "./workspace-default.ts";
import { ownedWorkspaceExists } from "./workspace-query.ts";

const WORKSPACE_NAME_MAXIMUM_LENGTH = 100;

function activeWorkspaceCondition(
  userId: string,
  workspaceId?: string,
): SQL | undefined {
  return and(
    eq(workspaces.userId, userId),
    not(workspaces.isDeleted),
    workspaceId === undefined ? undefined : eq(workspaces.id, workspaceId),
  );
}

function activeWorkspaceName(
  database: Pick<AppDatabase, "query">,
  userId: string,
  workspaceId: string,
): string | undefined {
  return database.query.workspaces
    .findFirst({
      columns: { name: true },
      where: activeWorkspaceCondition(userId, workspaceId),
    })
    .sync()?.name;
}

function workspaceSelection() {
  return {
    id: workspaces.id,
    isDefault: workspaces.isDefault,
    name: workspaces.name,
  };
}

function normalizeWorkspaceName(name: string): string | undefined {
  const normalized = name.trim();
  return normalized.length > 0 &&
    normalized.length <= WORKSPACE_NAME_MAXIMUM_LENGTH &&
    normalized.toLocaleLowerCase() !== GLOBAL_WORKSPACE_ID
    ? normalized
    : undefined;
}

type WorkspaceRemovalResult =
  "last_workspace" | "not_found" | "removed" | "workspace_in_use";

function normalizedWorkspaceName(
  name: string,
  action: (normalizedName: string) => WorkspaceSummary | undefined,
): WorkspaceSummary | undefined {
  const normalizedName = normalizeWorkspaceName(name);
  if (normalizedName === undefined) return undefined;
  try {
    return action(normalizedName);
  } catch (error) {
    if (isOperationProtocolError(error)) throw error;
    return undefined;
  }
}

export interface WorkspaceStore {
  create: (
    userId: string,
    name: string,
    now: number,
  ) => WorkspaceSummary | undefined;
  createDefault: (userId: string, now: number) => WorkspaceSummary;
  defaultForUser: (userId: string) => WorkspaceSummary | undefined;
  exists: (userId: string, workspaceId: string) => boolean;
  list: (userId: string) => WorkspaceList;
  rename: (
    userId: string,
    workspaceId: string,
    name: string,
    now: number,
  ) => WorkspaceSummary | undefined;
  remove: (
    userId: string,
    workspaceId: string,
    now: number,
  ) => WorkspaceRemovalResult;
  setDefault: (userId: string, workspaceId: string, now: number) => boolean;
}

export function createWorkspaceStore(
  database: AppDatabase,
  generateId: IdGenerator = createUuidV7,
  operationLimits?: OperationIntakeLimits,
): WorkspaceStore {
  const producer = commandOperationProducer(database, operationLimits);
  const store: WorkspaceStore = {
    create(
      userId: string,
      name: string,
      now: number,
    ): WorkspaceSummary | undefined {
      return normalizedWorkspaceName(name, (normalizedName) => {
        const id = generateId(now);
        return insertWorkspaceWithOperation(database, producer, {
          id,
          name: normalizedName,
          now,
          userId,
        });
      });
    },

    createDefault(userId: string, now: number): WorkspaceSummary {
      const existing = store.defaultForUser(userId);
      if (existing !== undefined) {
        return existing;
      }

      const id = generateId(now);
      return insertWorkspaceWithOperation(database, producer, {
        id,
        isDefault: true,
        name: DEFAULT_WORKSPACE_NAME,
        now,
        userId,
      });
    },

    defaultForUser(userId: string): WorkspaceSummary | undefined {
      return database
        .select(workspaceSelection())
        .from(workspaces)
        .where(defaultWorkspaceCondition(activeWorkspaceCondition(userId)))
        .get();
    },

    exists(userId: string, workspaceId: string): boolean {
      return (
        workspaceId !== GLOBAL_WORKSPACE_ID &&
        ownedWorkspaceExists(database, userId, workspaceId)
      );
    },

    list(userId: string): WorkspaceList {
      const entries = database
        .select(workspaceSelection())
        .from(workspaces)
        .where(activeWorkspaceCondition(userId))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
        .all();
      const defaultWorkspace = entries.find(({ isDefault }) => isDefault);

      if (defaultWorkspace === undefined) {
        throw new Error("The user has no default workspace");
      }

      return { defaultWorkspaceId: defaultWorkspace.id, workspaces: entries };
    },

    rename(
      userId: string,
      workspaceId: string,
      name: string,
      now: number,
    ): WorkspaceSummary | undefined {
      if (workspaceId === GLOBAL_WORKSPACE_ID) {
        return undefined;
      }
      return normalizedWorkspaceName(name, (normalizedName) =>
        database.transaction((transaction) => {
          const currentName = activeWorkspaceName(
            transaction,
            userId,
            workspaceId,
          );
          const [updated] = transaction
            .update(workspaces)
            .set({ name: normalizedName, ...updatedAuditFields(userId, now) })
            .where(activeWorkspaceCondition(userId, workspaceId))
            .returning(workspaceSelection())
            .all();
          if (updated !== undefined && currentName !== undefined)
            producer.produce(
              userId,
              normalizedName === currentName
                ? [legacyDefaultOperationIntent(database, userId)]
                : [
                    legacyDefaultOperationIntent(database, userId),
                    operationEntityIntent(
                      "workspaces",
                      workspaceId,
                      "workspace.name.set",
                      { value: normalizedName },
                      { name: currentName },
                    ),
                  ],
              now,
            );
          return updated;
        }),
      );
    },

    remove(
      userId: string,
      workspaceId: string,
      now: number,
    ): WorkspaceRemovalResult {
      if (workspaceId === GLOBAL_WORKSPACE_ID) {
        return "not_found";
      }

      return database.transaction((transaction) => {
        const workspace = transaction
          .select({ id: workspaces.id, isDefault: workspaces.isDefault })
          .from(workspaces)
          .where(activeWorkspaceCondition(userId, workspaceId))
          .get();
        if (workspace === undefined) {
          return "not_found";
        }

        const replacement = transaction
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(
            and(
              activeWorkspaceCondition(userId),
              ne(workspaces.id, workspaceId),
            ),
          )
          .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
          .get();
        if (replacement === undefined) {
          return "last_workspace";
        }

        const hasSession =
          transaction
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(
              and(
                eq(agentSessions.userId, userId),
                eq(agentSessions.workspaceId, workspaceId),
                not(agentSessions.isDeleted),
              ),
            )
            .get() !== undefined;
        const activeRunnerScope =
          transaction
            .select({ id: runnerWorkspaces.id })
            .from(runnerWorkspaces)
            .innerJoin(runners, eq(runnerWorkspaces.runnerId, runners.id))
            .where(
              and(
                eq(runnerWorkspaces.userId, userId),
                eq(runnerWorkspaces.workspaceId, workspaceId),
                not(runnerWorkspaces.isDeleted),
                not(runners.isDeleted),
              ),
            )
            .get() !== undefined;
        const activeCredentialScope =
          transaction
            .select({ id: providerCredentialWorkspaces.id })
            .from(providerCredentialWorkspaces)
            .innerJoin(
              providerCredentials,
              eq(
                providerCredentialWorkspaces.providerCredentialId,
                providerCredentials.id,
              ),
            )
            .where(
              and(
                activeCredentialWorkspaceCondition(userId, workspaceId),
                not(providerCredentials.isDeleted),
              ),
            )
            .get() !== undefined;

        if (hasSession || activeRunnerScope || activeCredentialScope) {
          return "workspace_in_use";
        }

        transaction
          .update(workspaces)
          .set({
            ...softDeletedAuditFields(userId, now),
            isDefault: false,
          })
          .where(eq(workspaces.id, workspaceId))
          .run();

        if (workspace.isDefault) {
          setWorkspaceDefault(transaction, replacement.id, userId, now);
        }
        producer.produce(
          userId,
          workspace.isDefault
            ? [
                operationEntityIntent(
                  "workspaces",
                  workspaceId,
                  "workspace.delete",
                  {},
                ),
                operationEntityEnsureIntent("workspaces", replacement.id, {
                  name: replacement.name,
                }),
                operationEntityIntent(
                  "users",
                  userId,
                  "user.default-workspace.set",
                  { defaultWorkspaceId: replacement.id },
                ),
              ]
            : [
                legacyDefaultOperationIntent(database, userId),
                operationEntityIntent(
                  "workspaces",
                  workspaceId,
                  "workspace.delete",
                  {},
                ),
              ],
          now,
        );
        return "removed";
      });
    },

    setDefault(userId: string, workspaceId: string, now: number): boolean {
      if (workspaceId === GLOBAL_WORKSPACE_ID) {
        return false;
      }

      return database.transaction((transaction) => {
        const targetName = activeWorkspaceName(
          transaction,
          userId,
          workspaceId,
        );
        if (targetName === undefined) {
          return false;
        }
        transaction
          .update(workspaces)
          .set(defaultValues(userId, now, false))
          .where(defaultWorkspaceCondition(activeWorkspaceCondition(userId)))
          .run();

        setWorkspaceDefault(transaction, workspaceId, userId, now);
        producer.produce(
          userId,
          [
            operationEntityEnsureIntent("workspaces", workspaceId, {
              name: targetName,
            }),
            operationEntityIntent(
              "users",
              userId,
              "user.default-workspace.set",
              { defaultWorkspaceId: workspaceId },
            ),
          ],
          now,
        );
        return true;
      });
    },
  };
  return store;
}
