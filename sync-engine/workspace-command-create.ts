import type { AppDatabase } from "../shared/database.ts";
import type { WorkspaceSummary } from "../shared/workspace-model.ts";
import type { commandOperationProducer } from "./command-operation-producer.ts";
import { legacyDefaultOperationIntent } from "./operation-producer-backfill.ts";
import { operationEntityIntent } from "./operation-producer.ts";
import { insertWorkspace } from "./workspace-write.ts";

export const insertWorkspaceWithOperation = (
  database: AppDatabase,
  producer: ReturnType<typeof commandOperationProducer>,
  values: {
    readonly id: string;
    readonly isDefault?: boolean;
    readonly name: string;
    readonly now: number;
    readonly userId: string;
  },
): WorkspaceSummary => {
  const id = values.id;
  return database.transaction((transaction) => {
    const created = insertWorkspace(transaction, { ...values, id });
    producer.produce(
      values.userId,
      values.isDefault === true
        ? [
            operationEntityIntent("workspaces", id, "workspace.create", {
              name: values.name,
            }),
            operationEntityIntent(
              "users",
              values.userId,
              "user.default-workspace.set",
              { defaultWorkspaceId: id },
            ),
          ]
        : [
            legacyDefaultOperationIntent(database, values.userId),
            operationEntityIntent("workspaces", id, "workspace.create", {
              name: values.name,
            }),
          ],
      values.now,
    );
    return created;
  });
};
