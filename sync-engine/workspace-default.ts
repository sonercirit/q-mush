import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { workspaces } from "../shared/database/schema.ts";
import { defaultValues } from "../shared/default-store.ts";

export function setWorkspaceDefault(
  database: Pick<AppDatabase, "update">,
  workspaceId: string,
  userId: string,
  now: number,
): void {
  database
    .update(workspaces)
    .set(defaultValues(userId, now, true))
    .where(eq(workspaces.id, workspaceId))
    .run();
}

export function defaultWorkspaceCondition(
  activeCondition: ReturnType<typeof and>,
) {
  return and(activeCondition, eq(workspaces.isDefault, true));
}
