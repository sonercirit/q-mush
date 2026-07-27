import { and, eq, inArray, not, or } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "./database.ts";
import { GLOBAL_WORKSPACE_ID } from "./workspace-model.ts";

export interface ScopedConnectionConfiguration {
  readonly associationTable: SQLiteTable & {
    readonly isDeleted: AnySQLiteColumn;
    readonly userId: AnySQLiteColumn;
    readonly workspaceId: AnySQLiteColumn;
  };
  readonly associationOwnerId: AnySQLiteColumn;
  readonly ownerGlobal: AnySQLiteColumn;
  readonly ownerId: AnySQLiteColumn;
  readonly ownerTable: SQLiteTable;
}

function selectedStrings(query: {
  readonly all: () => readonly { readonly id: unknown }[];
}): readonly string[] {
  return query.all().map(({ id }) => String(id));
}

export function accessibleConnectionIds(
  database: AppDatabase,
  configuration: ScopedConnectionConfiguration,
  userId: string,
  workspaceId: string,
  ownerCondition: ReturnType<typeof and>,
): readonly string[] {
  const scopedIds = selectedStrings(
    database
      .select({ id: configuration.associationOwnerId })
      .from(configuration.associationTable)
      .where(
        and(
          eq(configuration.associationTable.userId, userId),
          eq(configuration.associationTable.workspaceId, workspaceId),
          not(configuration.associationTable.isDeleted),
        ),
      ),
  );

  return selectedStrings(
    database
      .select({ id: configuration.ownerId })
      .from(configuration.ownerTable)
      .where(
        and(
          ownerCondition,
          workspaceId === GLOBAL_WORKSPACE_ID
            ? eq(configuration.ownerGlobal, true)
            : or(
                eq(configuration.ownerGlobal, true),
                inArray(configuration.ownerId, scopedIds),
              ),
        ),
      ),
  );
}
