import type { OperationApplyState } from "../shared/operation-core";
import { stabilizeOperationApplyState } from "../shared/operation-stability";
import {
  appendOperationId,
  applyOperationList,
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
  physicalMs: number,
  writerId: string,
) =>
  stabilizeOperationApplyState(
    state,
    stabilityClock(physicalMs, writerId),
    appendOperationId,
  );

export const stableArrayState = (): OperationApplyState<readonly string[]> =>
  stabilizeArrayState(
    applyOperationList(
      [testOperation("a", 1n, {}, "a", 10)],
      testApplyState<readonly string[]>([]),
      appendOperationId,
    ),
    10,
    "a",
  );
