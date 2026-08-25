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
const countingReducer = () => {
  let calls = 0;
  return {
    reduce: (projection: Projection, item: Operation) => {
      calls += 1;
      return reducer(projection, item);
    },
    calls: () => calls,
  };
};
const initialApplyState = (): OperationApplyState<Projection> => ({
  frontier: {},
  pending: [],
  projection: {},
  applied: {},
});

const fillPending = (
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  reduce: typeof reducer,
): OperationApplyState<Projection> => {
  let state = initialApplyState();
  for (let index = 0; index < MAX_PENDING_OPERATIONS; index += 1)
    state = applyOperation(
      state,
      operation(`writer-${index.toString()}`, sequence, parents, "x"),
      reduce,
    );
  return state;
};

describe("operation core", () => {
  test("classifies every replicated schema entity", () => {
    for (const entity of [
      "agent_messages",
      "agent_session_operations",
      "agent_sessions",
      "agent_session_turns",
      "agent_pending_inputs",
      "agent_question_requests",
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
    expect(() => classifyOperationPartition("sessions")).toThrow(
      /Unknown operation entity/,
    );
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
    expect(compareClocks(left, right)).toBe(-1);
    expect(compareClocks(right, left)).toBe(1);
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

  test("bounds never-ready admission without reducer work", () => {
    const counter = countingReducer();
    const state = fillPending(1n, { ghost: 9n }, counter.reduce);
    expect(counter.calls()).toBe(0);
    expect(() =>
      applyOperation(
        state,
        operation("overflow", 1n, { ghost: 9n }, "x"),
        reducer,
      ),
    ).toThrow(/pending buffer/);
  });

  test("applies a sequential stream with exactly one reducer call per operation", () => {
    let state = initialApplyState();
    const counter = countingReducer();
    for (let index = 1; index <= 800; index += 1)
      state = applyOperation(
        state,
        operation(
          "a",
          BigInt(index),
          index === 1 ? {} : { a: BigInt(index - 1) },
          "x",
        ),
        counter.reduce,
      );
    expect(counter.calls()).toBe(800);
    expect(state.history?.length).toBe(1);
  });

  test("admits a ready dependency into a full pending buffer and drains it", () => {
    const state = fillPending(2n, {}, reducer);
    const healed = applyOperation(
      state,
      operation("writer-0", 1n, {}, "one"),
      reducer,
    );
    expect(healed.frontier["writer-0"]).toBe(2n);
    expect(healed.pending).toHaveLength(MAX_PENDING_OPERATIONS - 1);
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
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        createOperation({
          ...first,
          operationId: "bad",
          payload: { value: invalid },
        }),
      ).toThrow(/finite/);
  });

  test("validates operation shape, dates, arrays, and identity", () => {
    const validationSeed = operation("validator", 1n, { missing: 1n }, "seed");
    expect(() => createOperation({ ...validationSeed, sequence: 0n })).toThrow(
      /sequence/,
    );
    expect(() =>
      createOperation({ ...validationSeed, schemaVersion: 0 }),
    ).toThrow(/schemaVersion/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      createOperation({ ...validationSeed, payload: cyclic }),
    ).toThrow(/must not be cyclic/);
    expect(() =>
      createOperation({ ...validationSeed, payload: () => undefined }),
    ).toThrow(/Unsupported operation value/);
    expect(() =>
      createOperation({ ...validationSeed, payload: Symbol("x") }),
    ).toThrow(/Unsupported operation value/);
    expect(() =>
      createOperation({ ...validationSeed, payload: new Map() }),
    ).toThrow(/must be plain/);
    const symbolObject = { value: "x", [Symbol("x")]: "y" };
    expect(() =>
      createOperation({ ...validationSeed, payload: symbolObject }),
    ).toThrow(/string-keyed/);
    const dated = createOperation({
      ...validationSeed,
      payload: { at: new Date(1) },
    });
    const waiting = applyOperation(initialApplyState(), dated, reducer);
    expect(() =>
      applyOperation(
        waiting,
        { ...dated, payload: { at: new Date(2) } },
        reducer,
      ),
    ).toThrow(/equivocation/);
    const arrayUndefined = createOperation({
      ...validationSeed,
      operationId: "array",
      writerId: "array",
      payload: [undefined],
    });
    const arrayWaiting = applyOperation(
      initialApplyState(),
      arrayUndefined,
      reducer,
    );
    expect(() =>
      applyOperation(
        arrayWaiting,
        { ...arrayUndefined, payload: [null] },
        reducer,
      ),
    ).toThrow(/equivocation/);
  });

  test("preserves input states and resumes checkpoint-shaped durable state", () => {
    const original = initialApplyState();
    applyOperation(original, operation("a", 1n, {}, "one"), reducer);
    expect(original).toEqual(initialApplyState());
    expect(() =>
      applyOperation(
        original,
        { ...operation("a", 1n, {}, "one"), operationId: "other" },
        reducer,
      ),
    ).not.toThrow();

    const emptyProjection: readonly string[] = [];
    const seeded = applyOperation(
      {
        frontier: {},
        pending: [],
        projection: emptyProjection,
        applied: {},
      },
      operation("a", 1n, {}, "one"),
      (projection, item) => [...projection, item.operationId],
    );
    const checkpoint: OperationApplyState<readonly string[]> = {
      frontier: seeded.frontier,
      pending: [],
      projection: seeded.projection,
      applied: seeded.applied,
    };
    const append = (projection: readonly string[], item: Operation) => [
      ...projection,
      item.operationId,
    ];
    let resumed = applyOperation(
      checkpoint,
      operation("a", 3n, { a: 2n }, "three"),
      append,
    );
    resumed = applyOperation(
      resumed,
      operation("a", 2n, { a: 1n }, "two"),
      append,
    );
    expect(resumed.projection).toEqual(["a-1", "a-2", "a-3"]);
    expect(
      applyOperation(resumed, operation("a", 1n, {}, "one"), append).projection,
    ).toEqual(resumed.projection);
  });

  test("compares every frontier relation and rejects gaps and writer-sequence equivocation", () => {
    expect(compareFrontiers({ a: 1n }, { a: 1n })).toBe("equal");
    expect(compareFrontiers({ a: 1n }, { a: 2n })).toBe("ancestor");
    expect(compareFrontiers({ a: 2n }, { a: 1n })).toBe("descendant");
    expect(() => advanceFrontier({ a: 1n }, "a", 3n)).toThrow(/gap/);
    const first = operation("a", 1n, { ghost: 1n }, "one");
    const waiting = applyOperation(initialApplyState(), first, reducer);
    expect(() =>
      applyOperation(
        waiting,
        { ...first, operationId: "fresh", payload: { value: "changed" } },
        reducer,
      ),
    ).toThrow(/writer:a:1/);
  });

  test("ticks the local hybrid clock forward and logically", () => {
    const clock = createHybridLogicalClock("a", 10);
    expect([clock.tick(20), clock.tick(20), clock.tick(15)]).toEqual([
      { physicalMs: 20, logical: 0, writerId: "a" },
      { physicalMs: 20, logical: 1, writerId: "a" },
      { physicalMs: 20, logical: 2, writerId: "a" },
    ]);
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
