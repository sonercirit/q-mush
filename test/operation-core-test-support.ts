import {
  applyOperation,
  createOperation,
  type Operation,
  type OperationApplyState,
} from "../shared/operation-core";
import { initialOperationApplyState } from "../shared/operation-intake-core";

export const testOperation = (
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
    entity: { type: "workspaces", id: "workspace-1", accountId: "account-1" },
    kind: "workspace.name.set",
    payload: { value },
  });

export const testSessionOperation = (
  writerId: string,
  sequence: bigint,
  value: string,
): Operation => {
  const operation = testOperation(writerId, sequence, {}, value);
  return {
    ...operation,
    partition: "session",
    entity: { ...operation.entity, type: "agent_sessions" },
  };
};

export const testApplyState = <T>(projection: T): OperationApplyState<T> =>
  initialOperationApplyState(projection);

export const appendOperationId = (
  projection: readonly string[],
  item: Operation,
): readonly string[] => [...projection, item.operationId];

export const applyOperationIds = (
  items: readonly Operation[],
  state = testApplyState<readonly string[]>([]),
): OperationApplyState<readonly string[]> =>
  applyOperationList(items, state, appendOperationId);

export const applyOperationList = <T>(
  items: readonly Operation[],
  state: OperationApplyState<T>,
  reducer: (projection: T, item: Operation) => T,
): OperationApplyState<T> =>
  items.reduce(
    (current, item) => applyOperation(current, item, reducer),
    state,
  );
