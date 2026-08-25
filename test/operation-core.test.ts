import { describe, expect, test } from "vitest";

import {
  advanceFrontier,
  applyOperation,
  classifyOperationPartition,
  compareClocks,
  compareFrontiers,
  createHybridLogicalClock,
  createOperation,
  frontierCovers,
  mergeFrontiers,
  type Operation,
  type OperationApplyState,
} from "../shared/operation-core";

type Projection = Readonly<Record<string, string>>;

const operation = (
  writerId: string,
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  value: string,
) =>
  createOperation({
    operationId: `${writerId}-${sequence.toString()}`,
    schemaVersion: 1,
    writerId,
    sequence,
    clock: { physicalMs: Number(sequence), logical: 0, writerId },
    parents,
    entity: { type: "workspaces", id: "workspace-1", accountId: "account-1" },
    kind: "workspace.name.set",
    payload: { value },
  });

const reducer = (projection: Projection, candidate: Operation): Projection => ({
  ...projection,
  [candidate.operationId]:
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    "value" in candidate.payload &&
    typeof candidate.payload.value === "string"
      ? candidate.payload.value
      : "invalid",
});

describe("operation core", () => {
  test("classifies the declared partition from the entity rather than trusting input", () => {
    expect(classifyOperationPartition("agent_messages")).toBe("session");
    expect(classifyOperationPartition("workspaces")).toBe("non-session");
    expect(() => classifyOperationPartition("future_entity")).toThrow(
      /Unknown operation entity/,
    );
    expect(operation("writer-a", 1n, {}, "one").partition).toBe("non-session");
  });

  test("ticks and receives hybrid logical clocks monotonically despite wall-clock rollback", () => {
    const clock = createHybridLogicalClock("writer-a", 100);
    expect(clock.tick(90)).toEqual({
      physicalMs: 100,
      logical: 1,
      writerId: "writer-a",
    });
    expect(
      clock.receive({ physicalMs: 110, logical: 4, writerId: "writer-b" }, 105),
    ).toEqual({
      physicalMs: 110,
      logical: 5,
      writerId: "writer-a",
    });
    expect(
      compareClocks(clock.tick(110), {
        physicalMs: 110,
        logical: 5,
        writerId: "writer-b",
      }),
    ).toBeGreaterThan(0);
  });

  test("compares, merges, advances, and checks causal frontiers", () => {
    const left = { a: 2n, b: 1n };
    const right = { a: 1n, c: 3n };
    expect(compareFrontiers(left, right)).toBe("concurrent");
    expect(mergeFrontiers(left, right)).toEqual({ a: 2n, b: 1n, c: 3n });
    expect(advanceFrontier(left, "a", 3n)).toEqual({ a: 3n, b: 1n });
    expect(() => advanceFrontier(left, "a", 4n)).toThrow(/sequence gap/);
    expect(frontierCovers(mergeFrontiers(left, right), right)).toBe(true);
    expect(compareFrontiers(left, { a: 1n })).toBe("descendant");
  });

  test("buffers out-of-order arrivals and applies each operation exactly once", () => {
    const first = operation("writer-a", 1n, {}, "one");
    const second = operation("writer-a", 2n, { "writer-a": 1n }, "two");
    const initial: OperationApplyState<Projection> = {
      frontier: {},
      pending: [],
      projection: {},
      applied: {},
    };
    const waiting = applyOperation(initial, second, reducer);
    expect(waiting.projection).toEqual({});
    expect(waiting.pending).toEqual([second]);

    const converged = applyOperation(waiting, first, reducer);
    expect(converged.projection).toEqual({
      "writer-a-1": "one",
      "writer-a-2": "two",
    });
    expect(converged.frontier).toEqual({ "writer-a": 2n });
    expect(converged.pending).toEqual([]);
    expect(applyOperation(converged, first, reducer)).toBe(converged);
  });

  test("rejects operation identity or writer-sequence equivocation", () => {
    const first = operation("writer-a", 1n, {}, "one");
    const initial: OperationApplyState<Projection> = {
      frontier: {},
      pending: [],
      projection: {},
      applied: {},
    };
    const applied = applyOperation(initial, first, reducer);
    expect(() =>
      applyOperation(
        applied,
        { ...first, payload: { value: "changed" } },
        reducer,
      ),
    ).toThrow(/equivocation/);
    expect(() =>
      applyOperation(applied, { ...first, operationId: "different" }, reducer),
    ).toThrow(/equivocation/);
  });
});
