import { createOperation, type Operation } from "../shared/operation-core";
import {
  operationEntityIntent,
  type OperationProducerIntent,
} from "../sync-engine/operation-producer";

export const producerWorkspace = (
  id: string,
  name: string,
): OperationProducerIntent =>
  operationEntityIntent("workspaces", id, "workspace.create", { name });

export const producerPrompt = (
  id: string,
  body: string,
): OperationProducerIntent =>
  operationEntityIntent("prompts", id, "prompt.create", { name: "P", body });

export const producerOperation = (
  ownerId: string,
  operationId: string,
  sequence: bigint,
  physicalMs: number,
  logical = 0,
): Operation => {
  const entityId = `${operationId}-workspace`;
  return createOperation({
    operationId,
    schemaVersion: 1,
    writerId: ownerId,
    sequence,
    clock: { physicalMs, logical, writerId: ownerId },
    parents: {},
    entity: { accountId: ownerId, id: entityId, type: "workspaces" },
    kind: "workspace.create",
    payload: { name: entityId },
  });
};

import { entityTestOperation } from "./operation-entity-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

export const largeEntityEnvelope = (
  ownerId: string,
  sequence: bigint,
  payloadBytes: number,
  now = Date.now(),
) =>
  entityTestOperation(
    ownerId,
    sequence,
    sequence === 1n ? {} : { [ownerId]: sequence - 1n },
    "x".repeat(payloadBytes),
    now,
  );

export const operationDatabase = () => {
  const harness = createOperationDatabaseHarness();
  return { harness, database: harness.setup().database };
};
