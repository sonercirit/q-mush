import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { WorkspaceSummary } from "../shared/workspace-model.ts";
import { commandOperationProducer } from "./command-operation-producer.ts";
import type { OperationIntakeLimits } from "./operation-intake.ts";
import { legacyDefaultOperationIntent } from "./operation-producer-backfill.ts";
import { operationEntityIntent } from "./operation-producer.ts";
import { insertWorkspace } from "./workspace-write.ts";

export const insertWorkspaceWithOperation = (
  database: AppDatabase,
  generateId: IdGenerator,
  values: {
    readonly isDefault?: boolean;
    readonly name: string;
    readonly now: number;
    readonly userId: string;
  },
  operationLimits?: OperationIntakeLimits,
): WorkspaceSummary => {
  const id = generateId(values.now);
  return database.transaction((transaction) => {
    const created = insertWorkspace(transaction, { ...values, id });
    const producer = commandOperationProducer(database, operationLimits);
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
