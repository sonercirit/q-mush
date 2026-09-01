import { createOperationSynchronization } from "./operation-synchronization.ts";
import type { RequestHandlerIntegrations } from "./server-integrations.ts";

export const operationSynchronizationHandler = (
  integrations: RequestHandlerIntegrations,
) =>
  createOperationSynchronization(integrations.database, integrations.runners);
