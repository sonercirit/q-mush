import { and, eq, not } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { workspaces } from "../shared/database/schema.ts";

function activeOwnedWorkspaceCondition(userId: string, workspaceId: string) {
  return and(
    eq(workspaces.id, workspaceId),
    eq(workspaces.userId, userId),
    not(workspaces.isDeleted),
  );
}

export function ownedWorkspaceExists(
  database: Pick<AppDatabase, "select">,
  userId: string,
  workspaceId: string,
): boolean {
  return (
    database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(activeOwnedWorkspaceCondition(userId, workspaceId))
      .get() !== undefined
  );
}
