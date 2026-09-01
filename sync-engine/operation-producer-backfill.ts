import type { AppDatabase } from "../shared/database.ts";
import { operationAccountIntent } from "./operation-producer.ts";

export const legacyDefaultOperationIntent = (
  database: AppDatabase,
  userId: string,
) => {
  const current = database.query.workspaces
    .findFirst({
      columns: { id: true, name: true },
      where: (workspace, { and, eq }) =>
        and(eq(workspace.userId, userId), eq(workspace.isDefault, true)),
    })
    .sync();
  return operationAccountIntent(current ?? null);
};
