import { describe, expect, test } from "vitest";

import {
  MAX_PENDING_OPERATIONS,
  MAX_REMOTE_CLOCK_DRIFT_MS,
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
  physicalMs = Number(sequence),
) =>
  createOperation({
    operationId: `${writerId}-${sequence.toString()}`,
    schemaVersion: 1,
    writerId,
    sequence,
    clock: { physicalMs, logical: 0, writerId },
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
const initialApplyState = (): OperationApplyState<Projection> => ({
  frontier: {},
  pending: [],
  projection: {},
  applied: {},
});

describe("operation core", () => {
  test("classifies every replicated schema entity", () => {
    for (const entity of [
      "agent_messages",
      "agent_session_operations",
      "agent_sessions",
      "agent_session_turns",
      "agent_pending_inputs",
      "agent_question_requests",
      "sessions",
    ])
      expect(classifyOperationPartition(entity)).toBe("session");
    for (const entity of [
      "users",
      "workspaces",
      "prompts",
      "provider_credentials",
      "provider_quota_settings",
      "provider_quota_reset_receipts",
      "provider_credential_workspaces",
      "attachment_fallbacks",
      "runners",
      "runner_workspaces",
      "tool_settings",
    ])
      expect(classifyOperationPartition(entity)).toBe("non-session");
    expect(() => classifyOperationPartition("future_entity")).toThrow(
      /Unknown operation entity/,
    );
  });

  test("covers every HLC receive winner and rejects far-future clocks", () => {
    const remoteWins = createHybridLogicalClock("a", 100);
    expect(
      remoteWins.receive({ physicalMs: 110, logical: 4, writerId: "b" }, 105)
        .logical,
    ).toBe(5);
    const localWins = createHybridLogicalClock("a", 120);
    expect(
      localWins.receive({ physicalMs: 110, logical: 4, writerId: "b" }, 105),
    ).toMatchObject({ physicalMs: 120, logical: 1 });
    const nowWins = createHybridLogicalClock("a", 100);
    expect(
      nowWins.receive({ physicalMs: 110, logical: 4, writerId: "b" }, 120),
    ).toMatchObject({ physicalMs: 120, logical: 0 });
    expect(() =>
      nowWins.receive(
        {
          physicalMs: 120 + MAX_REMOTE_CLOCK_DRIFT_MS + 1,
          logical: 0,
          writerId: "b",
        },
        120,
      ),
    ).toThrow(/future/);
  });

  test("uses a strict locale-independent clock and canonical key order", () => {
    const left = { physicalMs: 1, logical: 1, writerId: "z" };
    const right = { physicalMs: 1, logical: 1, writerId: "ä" };
    expect(compareClocks(left, right)).not.toBe(0);
    expect(compareClocks(left, right)).toBe(-compareClocks(right, left));
    const first = operation("a", 1n, {}, "one");
    const applied = applyOperation(initialApplyState(), first, reducer);
    const reordered = {
      ...first,
      payload: { value: "one" },
      entity: { accountId: "account-1", id: "workspace-1", type: "workspaces" },
    };
    expect(applyOperation(applied, reordered, reducer)).toBe(applied);
  });

  test("converges concurrent non-commutative updates across arrival permutations", () => {
    const setName = (_projection: string, item: Operation) => {
      if (
        typeof item.payload === "object" &&
        item.payload !== null &&
        "value" in item.payload &&
        typeof item.payload.value === "string"
      )
        return item.payload.value;
      return "invalid";
    };
    const x = operation("b", 1n, {}, "X", 1);
    const y = operation("c", 1n, {}, "Y", 1);
    const run = (items: readonly Operation[]) => {
      const initial: OperationApplyState<string> = {
        frontier: {},
        pending: [],
        projection: "",
        applied: {},
      };
      return items.reduce<OperationApplyState<string>>(
        (state, item) => applyOperation(state, item, setName),
        initial,
      );
    };
    expect(run([x, y]).projection).toBe(run([y, x]).projection);
    expect(run([x, y]).projection).toBe("Y");
  });

  test("bounds never-ready admission and remains fast with indexed identities", () => {
    let state = initialApplyState();
    const started = performance.now();
    for (let index = 0; index < MAX_PENDING_OPERATIONS; index += 1)
      state = applyOperation(
        state,
        operation(`writer-${index.toString()}`, 1n, { ghost: 9n }, "x"),
        reducer,
      );
    expect(state.pending).toHaveLength(MAX_PENDING_OPERATIONS);
    expect(() =>
      applyOperation(
        state,
        operation("overflow", 1n, { ghost: 9n }, "x"),
        reducer,
      ),
    ).toThrow(/pending buffer/);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("omits undefined object properties but distinguishes null from non-finite numbers", () => {
    const first = operation("a", 1n, { ghost: 1n }, "one");
    const entity = { ...first.entity };
    Object.defineProperty(entity, "workspaceId", {
      enumerable: true,
      value: undefined,
    });
    const withUndefined: Operation = { ...first, entity };
    const waiting = applyOperation(initialApplyState(), withUndefined, reducer);
    expect(
      applyOperation(
        waiting,
        {
          ...first,
          entity: {
            type: "workspaces",
            id: "workspace-1",
            accountId: "account-1",
          },
        },
        reducer,
      ),
    ).toBe(waiting);
    expect(() =>
      createOperation({
        ...first,
        operationId: "bad",
        payload: { value: Number.NaN },
      }),
    ).toThrow(/finite/);
    expect(() =>
      createOperation({
        ...first,
        operationId: "bad",
        payload: { value: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/finite/);
  });

  test("compares, merges, advances, buffers, and rejects equivocation", () => {
    expect(compareFrontiers({ a: 2n }, { b: 1n })).toBe("concurrent");
    expect(mergeFrontiers({ a: 2n }, { a: 1n, c: 3n })).toEqual({
      a: 2n,
      c: 3n,
    });
    expect(advanceFrontier({ a: 2n }, "a", 3n)).toEqual({ a: 3n });
    expect(frontierCovers({ a: 2n }, { a: 1n })).toBe(true);
    const first = operation("a", 1n, {}, "one");
    const second = operation("a", 2n, { a: 1n }, "two");
    const waiting = applyOperation(initialApplyState(), second, reducer);
    const applied = applyOperation(waiting, first, reducer);
    expect(applied.pending).toEqual([]);
    expect(applied.frontier).toEqual({ a: 2n });
    expect(applyOperation(applied, first, reducer)).toBe(applied);
    expect(() =>
      applyOperation(
        applied,
        { ...first, payload: { value: "changed" } },
        reducer,
      ),
    ).toThrow(/equivocation/);
  });
});
