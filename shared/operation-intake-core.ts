import {
  applyOperation,
  operationProtocolError,
  snapshotOperationEnvelope,
  type Operation,
  type OperationApplyState,
  type OperationPartition,
} from "./operation-core.ts";
import { validateEntityOperation } from "./operation-entities.ts";
import { utf8ByteLength } from "./utf8.ts";

const MAX_SYNCHRONIZATION_FRONTIER_COMPONENT_BYTES = 16 * 1024;
const validSynchronizationFrontierComponent = (value: string): boolean =>
  value.length > 0 &&
  value !== "__proto__" &&
  utf8ByteLength(value) <= MAX_SYNCHRONIZATION_FRONTIER_COMPONENT_BYTES;

const validSynchronizationSequenceText = (value: unknown): value is string =>
  typeof value === "string" &&
  utf8ByteLength(value) <= MAX_SYNCHRONIZATION_FRONTIER_COMPONENT_BYTES &&
  /^(0|[1-9]\d*)$/.test(value);

export const parseSynchronizationFrontier = (
  value: unknown,
  maximumWriters = 512,
): Readonly<Record<string, bigint>> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value);
  if (entries.length > maximumWriters) return undefined;
  const result: Record<string, bigint> = {};
  for (const [writerId, sequence] of entries) {
    if (
      !validSynchronizationFrontierComponent(writerId) ||
      !validSynchronizationSequenceText(sequence)
    )
      return undefined;
    result[writerId] = BigInt(sequence);
  }
  return result;
};

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
  stableClock: undefined,
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
    const entityError = validateEntityOperation(snapshot);
    if (entityError !== undefined)
      throw operationProtocolError("invalid", entityError);
    if (
      snapshot.partition !== partition ||
      !(resources.ownsOperation?.(snapshot) ?? true)
    )
      throw operationProtocolError(
        "invalid",
        "Operation intake scope mismatch",
      );
    successor = applyOperation(successor, snapshot, resources.reducer);
    resources.append(encoded, snapshot);
  }
  return successor;
};
