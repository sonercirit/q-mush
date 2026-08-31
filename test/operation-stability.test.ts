import { describe, expect, test } from "vitest";

import { applyOperation, materializeApplied } from "../shared/operation-core";
import { stabilizeOperationApplyState } from "../shared/operation-stability";
import {
  appendOperationId,
  applyOperationList,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";

const operation = testOperation;

describe("operation stability", () => {
  test("folds a safe prefix and preserves convergence for a later clock insertion", () => {
    const first = operation("a", 1n, {}, "one", 10);
    const later = operation("b", 1n, {}, "later", 30);
    const between = operation("c", 1n, {}, "between", 25);
    const unfolded = applyOperationList(
      [first, later],
      testApplyState<readonly string[]>([]),
      appendOperationId,
    );
    const folded = stabilizeOperationApplyState(
      unfolded,
      { physicalMs: 10, logical: 0, writerId: "a" },
      appendOperationId,
    );
    expect(folded.baseProjection).toEqual(["a-1"]);
    expect(folded.baseFrontier).toEqual({ a: 1n });
    expect(folded.stableClock).toEqual(first.clock);
    expect(folded.replayCount).toBe(1);
    expect(Object.keys(materializeApplied(folded.applied))).toHaveLength(2);

    const foldedSuccessor = applyOperation(folded, between, appendOperationId);
    const unfoldedSuccessor = applyOperation(
      unfolded,
      between,
      appendOperationId,
    );
    expect(foldedSuccessor.projection).toEqual(unfoldedSuccessor.projection);
    expect(foldedSuccessor.frontier).toEqual(unfoldedSuccessor.frontier);
  });

  test("refuses clocks above the frontier writer minimum", () => {
    const state = applyOperationList(
      [operation("a", 1n, {}, "a", 10), operation("b", 1n, {}, "b", 20)],
      testApplyState<readonly string[]>([]),
      appendOperationId,
    );
    const folded = stabilizeOperationApplyState(
      state,
      { physicalMs: 99, logical: 0, writerId: "z" },
      appendOperationId,
    );
    expect(folded.replayCount).toBe(1);
    expect(folded.stableClock?.physicalMs).toBe(10);
  });

  test("a fully folded dormant writer pins subsequent stabilization", () => {
    const first = applyOperation(
      testApplyState<readonly string[]>([]),
      operation("a", 1n, {}, "a", 10),
      appendOperationId,
    );
    const folded = stabilizeOperationApplyState(
      first,
      { physicalMs: 10, logical: 0, writerId: "a" },
      appendOperationId,
    );
    const next = applyOperation(
      folded,
      operation("b", 1n, {}, "b", 20),
      appendOperationId,
    );
    expect(
      stabilizeOperationApplyState(
        next,
        { physicalMs: 99, logical: 0, writerId: "z" },
        appendOperationId,
      ),
    ).toBe(next);
  });

  test("pending clocks are strict fold caps", () => {
    const applied = applyOperation(
      testApplyState<readonly string[]>([]),
      operation("a", 1n, {}, "a", 20),
      appendOperationId,
    );
    const pending = applyOperation(
      applied,
      operation("b", 2n, { b: 1n }, "pending", 10),
      appendOperationId,
    );
    expect(
      stabilizeOperationApplyState(
        pending,
        { physicalMs: 99, logical: 0, writerId: "z" },
        appendOperationId,
      ),
    ).toBe(pending);
  });

  test("rejects new identities at or below stableClock but admits above", () => {
    const state = stabilizeOperationApplyState(
      applyOperation(
        testApplyState<readonly string[]>([]),
        operation("a", 1n, {}, "a", 10),
        appendOperationId,
      ),
      { physicalMs: 10, logical: 0, writerId: "a" },
      appendOperationId,
    );
    expect(() =>
      applyOperation(
        state,
        operation("a", 2n, { a: 1n }, "at", 10),
        appendOperationId,
      ),
    ).toThrow(/stable boundary/);
    expect(
      applyOperation(state, operation("b", 1n, {}, "b", 11), appendOperationId)
        .frontier,
    ).toEqual({ a: 1n, b: 1n });
  });
});
