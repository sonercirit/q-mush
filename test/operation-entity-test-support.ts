import { createOperation, type Operation } from "../shared/operation-core";

export const entityTestOperation = (
  writerId: string,
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  value: string,
  physicalMs = Number(sequence),
): Operation =>
  createOperation({
    operationId: `${writerId}-${sequence.toString()}`,
    schemaVersion: 1,
    writerId,
    sequence,
    clock: { physicalMs, logical: 0, writerId },
    parents,
    entity: {
      type: "workspaces",
      id: `workspace-${writerId}`,
      accountId: "account-1",
    },
    kind: "workspace.create",
    payload: { name: value },
  });
