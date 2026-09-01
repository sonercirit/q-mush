import type { AppDatabase } from "../shared/database.ts";
import type { OperationIntakeLimits } from "./operation-intake.ts";
import { createOperationProducer } from "./operation-producer.ts";

export const commandOperationProducer = (
  database: AppDatabase,
  limits?: OperationIntakeLimits,
) =>
  createOperationProducer({
    database,
    ...(limits === undefined ? {} : { limits }),
  });
