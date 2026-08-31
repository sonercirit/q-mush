import { describe, expect, test } from "vitest";

import {
  applyOperation,
  materializeApplied,
  type Operation,
} from "../shared/operation-core";
import {
  appendOperationId,
  applyOperationIds,
  testOperation,
} from "./operation-core-test-support";
import {
  singleWriterArrayState,
  stabilizeForWriter,
} from "./operation-stability-test-support";

const operation = testOperation;
const operationIdState = (items: readonly Operation[]) =>
  applyOperationIds(items);

describe("operation stability", () => {
  test("folds a safe prefix and preserves convergence for a later clock insertion", () => {
    const first = operation("a", 1n, {}, "one", 10);
    const later = operation("b", 1n, {}, "later", 30);
    const between = operation("c", 1n, {}, "between", 25);
    const unfolded = operationIdState([first, later]);
    const folded = stabilizeForWriter(unfolded, 10, "a");
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
    const state = operationIdState([
      operation("a", 1n, {}, "a", 10),
      operation("b", 1n, {}, "b", 20),
    ]);
    const folded = stabilizeForWriter(state, 99, "z");
    expect(folded.replayCount).toBe(1);
    expect(folded.stableClock?.physicalMs).toBe(10);
  });

  test("a fully folded dormant writer pins subsequent stabilization", () => {
    const first = singleWriterArrayState("a", 10);
    const folded = stabilizeForWriter(first, 10, "a");
    const next = applyOperation(
      folded,
      operation("b", 1n, {}, "b", 20),
      appendOperationId,
    );
    expect(stabilizeForWriter(next, 99, "z")).toBe(next);
  });

  test("pending clocks are strict fold caps", () => {
    const applied = singleWriterArrayState("a", 10);
    const pending = {
      ...applied,
      pending: [operation("a", 3n, { a: 2n }, "pending", 10)],
    };
    expect(stabilizeForWriter(pending, 99, "z")).toBe(pending);
  });

  test("rejects new identities at or below stableClock but admits above", () => {
    const state = stabilizeForWriter(singleWriterArrayState("a", 10), 10, "a");
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
