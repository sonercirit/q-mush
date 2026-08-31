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

export const stableArrayState = (): OperationApplyState<readonly string[]> =>
  stabilizeOperationApplyState(
    applyOperationList(
      [testOperation("a", 1n, {}, "a", 10)],
      testApplyState<readonly string[]>([]),
      appendOperationId,
    ),
    stabilityClock(10, "a"),
    appendOperationId,
  );
