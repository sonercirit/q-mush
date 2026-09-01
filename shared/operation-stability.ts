import {
  advanceOperationFrontier,
  buildAppliedIdentityIndex,
  compareClocks,
  MAX_REMOTE_CLOCK_DRIFT_MS,
  reduceOperationSequence,
  replayOperationsOldestFirst,
  type CausalFrontier,
  type HybridTimestamp,
  type Operation,
  type OperationApplyState,
  type OperationReducer,
  type ReplayEntry,
} from "./operation-core.ts";

export interface OperationStabilityBoundary {
  readonly stableClock: HybridTimestamp | null;
  readonly stableFrontier: CausalFrontier | null;
}

const replayHead = (
  operations: readonly Operation[],
): ReplayEntry | undefined => {
  let head: ReplayEntry | undefined;
  for (const operation of operations) head = { operation, previous: head };
  return head;
};
/**
 * Folds only a clock-ordered prefix bounded by the caller's trusted cap and
 * every pending clock. The caller must prove that no operation at or below the
 * cap can arrive later; frontier writer heads are deliberately not fold caps.
 */
export const stabilizeOperationApplyState = <TProjection>(
  state: OperationApplyState<TProjection>,
  boundaryClock: HybridTimestamp,
  reducer: OperationReducer<TProjection>,
): OperationApplyState<TProjection> => {
  if (
    state.stableClock !== undefined &&
    compareClocks(boundaryClock, state.stableClock) <= 0
  )
    return state;
  const replay = replayOperationsOldestFirst(state.replayHead);
  if (replay.length === 0) return state;
  const foldCount = replay.findIndex(
    (operation) =>
      compareClocks(operation.clock, boundaryClock) > 0 ||
      state.pending.some(
        (pending) => compareClocks(operation.clock, pending.clock) >= 0,
      ),
  );
  return foldPrefix(
    state,
    replay,
    foldCount < 0 ? replay.length : foldCount,
    reducer,
  );
};

const foldPrefix = <TProjection>(
  state: OperationApplyState<TProjection>,
  replay: readonly Operation[],
  requestedCount: number,
  reducer: OperationReducer<TProjection>,
): OperationApplyState<TProjection> => {
  const count = requestedCount;
  if (count === 0) return state;
  const folded = replay.slice(0, count);
  const retained = replay.slice(count);
  return {
    ...state,
    baseProjection: reduceOperationSequence(
      state.baseProjection,
      folded,
      reducer,
    ),
    baseFrontier: advanceOperationFrontier(state.baseFrontier, folded),
    stableClock: folded.at(-1)?.clock,
    replayHead: replayHead(retained),
    replayCount: retained.length,
    replayLastClock: retained.at(-1)?.clock,
    applied: buildAppliedIdentityIndex(retained),
  };
};

/** Engine cap representing exactly physicalMs < now - drift. */
export const engineStabilityBoundaryClock = (
  now: number,
): HybridTimestamp | undefined => {
  const cutoff = now - MAX_REMOTE_CLOCK_DRIFT_MS;
  // HLC physical time is integral and non-negative, so cutoff - 1 turns the
  // strict physical condition into an inclusive clock cap.
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) return undefined;
  return {
    physicalMs: cutoff - 1,
    logical: Number.MAX_SAFE_INTEGER,
    writerId: "\uffff",
  };
};
