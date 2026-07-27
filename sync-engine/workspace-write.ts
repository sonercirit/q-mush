import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { workspaces } from "../shared/database/schema.ts";
import type { WorkspaceSummary } from "../shared/workspace-model.ts";

export function insertWorkspace(
  database: Pick<AppDatabase, "insert">,
  values: Readonly<{
    id: string;
    isDefault?: boolean;
    name: string;
    now: number;
    userId: string;
  }>,
): WorkspaceSummary {
  database
    .insert(workspaces)
    .values({
      ...createdAuditFields(values.userId, values.now),
      id: values.id,
      ...(values.isDefault === true ? { isDefault: true } : {}),
      name: values.name,
      userId: values.userId,
    })
    .run();
  return {
    id: values.id,
    isDefault: values.isDefault ?? false,
    name: values.name,
  };
}
