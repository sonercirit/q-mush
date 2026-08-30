import {
  applyOperation,
  operationProtocolError,
  snapshotOperationEnvelope,
  type Operation,
  type OperationApplyState,
  type OperationPartition,
} from "./operation-core.ts";

interface IntakeCandidate {
  readonly encoded: string;
  readonly operation: Operation;
}
interface IntakeResources<Projection> {
  readonly append: (encoded: string, operation: Operation) => void;
  readonly ownsOperation?: (operation: Operation) => boolean;
  readonly reducer: (
    projection: Projection,
    operation: Operation,
  ) => Projection;
}

export const applyOperationIntakeBatch = <Projection>(
  ownerId: string,
  partition: OperationPartition,
  state: OperationApplyState<Projection>,
  candidates: readonly IntakeCandidate[],
  resources: IntakeResources<Projection>,
): OperationApplyState<Projection> => {
  let successor = state;
  for (const { encoded, operation } of candidates) {
    const snapshot = snapshotOperationEnvelope(operation);
    if (
      snapshot.partition !== partition ||
      !(
        resources.ownsOperation?.(snapshot) ??
        snapshot.entity.accountId === ownerId
      )
    )
      throw operationProtocolError(
        "invalid",
        "Operation intake scope mismatch",
      );
    resources.append(encoded, snapshot);
    successor = applyOperation(successor, snapshot, resources.reducer);
  }
  return successor;
};
