import { createRunnerOperationSynchronization } from "./operation-synchronization.ts";
import type { RequestHandlerIntegrations } from "./server-integrations.ts";

export const operationSynchronizationHandler = (
  integrations: RequestHandlerIntegrations,
) =>
  createRunnerOperationSynchronization(
    integrations.database,
    integrations.runners,
  );
