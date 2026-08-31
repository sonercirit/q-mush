import {
  advanceOperationFrontier,
  buildAppliedIdentityIndex,
  compareClocks,
  MAX_REMOTE_CLOCK_DRIFT_MS,
  reduceOperationSequence,
  type HybridTimestamp,
  type Operation,
  type OperationApplyState,
  type ReplayEntry,
} from "./operation-core.ts";

const replayOldestFirst = (head: ReplayEntry | undefined): Operation[] => {
  const operations: Operation[] = [];
  for (let entry = head; entry !== undefined; entry = entry.previous)
    operations.push(entry.operation);
  operations.reverse();
  return operations;
};
const replayHead = (
  operations: readonly Operation[],
): ReplayEntry | undefined => {
  let head: ReplayEntry | undefined;
  for (const operation of operations) head = { operation, previous: head };
  return head;
};
const earlierClock = (
  left: HybridTimestamp,
  right: HybridTimestamp,
): HybridTimestamp => (compareClocks(left, right) <= 0 ? left : right);

/**
 * Folds only a clock-ordered prefix bounded by the caller's trusted cap, every
 * frontier writer's latest operation, and every pending clock. A frontier
 * writer absent from retained replay was folded previously, so stableClock is
 * its conservative stand-in and pins this and later folds.
 */
export const stabilizeOperationApplyState = <TProjection>(
  state: OperationApplyState<TProjection>,
  boundaryClock: HybridTimestamp,
  reducer: (projection: TProjection, operation: Operation) => TProjection,
): OperationApplyState<TProjection> => {
  const replay = replayOldestFirst(state.replayHead);
  if (replay.length === 0) return state;
  const latestByWriter = new Map<string, HybridTimestamp>();
  for (const operation of replay)
    if (operation.sequence === state.frontier[operation.writerId])
      latestByWriter.set(operation.writerId, operation.clock);
  let cap = boundaryClock;
  for (const writerId of Object.keys(state.frontier)) {
    const writerClock = latestByWriter.get(writerId) ?? state.stableClock;
    if (writerClock === undefined) return state;
    cap = earlierClock(cap, writerClock);
  }
  const foldCount = replay.findIndex(
    (operation) =>
      compareClocks(operation.clock, cap) > 0 ||
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
  reducer: (projection: TProjection, operation: Operation) => TProjection,
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
