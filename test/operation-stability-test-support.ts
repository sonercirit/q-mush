import type { OperationApplyState } from "../shared/operation-core";
import { stabilizeOperationApplyState } from "../shared/operation-stability";
import {
  appendOperationId,
  applyOperationIds,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";

export const stabilityClock = (physicalMs: number, writerId: string) => ({
  physicalMs,
  logical: 0,
  writerId,
});

export const stabilizeArrayState = (
  state: OperationApplyState<readonly string[]>,
  clock: ReturnType<typeof stabilityClock>,
) => stabilizeOperationApplyState(state, clock, appendOperationId);

export const stabilizeForWriter = (
  state: OperationApplyState<readonly string[]>,
  physicalMs: number,
  writerId: string,
) => stabilizeArrayState(state, stabilityClock(physicalMs, writerId));

export const singleWriterArrayState = (
  writerId: string,
  physicalMs: number,
): OperationApplyState<readonly string[]> =>
  applyOperationIds([testOperation(writerId, 1n, {}, writerId, physicalMs)]);

export const invalidStableBaseStates = (): readonly OperationApplyState<
  readonly string[]
>[] => {
  const empty = testApplyState<readonly string[]>([]);
  return [
    { ...empty, stableClock: stabilityClock(1, "a") },
    { ...empty, baseFrontier: { a: 1n } },
  ];
};

export const stableArrayState = (): OperationApplyState<readonly string[]> =>
  stabilizeForWriter(singleWriterArrayState("a", 10), 10, "a");
