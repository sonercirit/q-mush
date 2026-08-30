import {
  applyOperation,
  operationProtocolError,
  snapshotOperationEnvelope,
  type Operation,
  type OperationApplyState,
  type OperationPartition,
} from "./operation-core.ts";

export const prepareSynchronizationFrontier = (
  frontier: Readonly<Record<string, bigint>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(frontier).map(([writerId, sequence]) => [
      writerId,
      sequence.toString(),
    ]),
  );

export const initialOperationApplyState = <Projection>(
  projection: Projection,
): OperationApplyState<Projection> => ({
  frontier: {},
  pending: [],
  projection,
  applied: undefined,
  replayHead: undefined,
  replayCount: 0,
  replayLastClock: undefined,
  baseProjection: projection,
  baseFrontier: {},
});

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
      !(resources.ownsOperation?.(snapshot) ?? true)
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
