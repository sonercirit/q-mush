import { describe, expect, test } from "vitest";

import { testApplyState, testOperation } from "./operation-core-test-support";

import {
  advanceFrontier,
  appliedIdentityDepth,
  applyOperation,
  compareFrontiers,
  createHybridLogicalClock,
  createOperation,
  frontierCovers,
  materializeApplied,
  MAX_OPERATION_BATCH_SIZE,
  mergeFrontiers,
  type Operation,
  type OperationApplyState,
} from "../shared/operation-core";

type Projection = Readonly<Record<string, string>>;

const workspaceEntity = () => ({
  type: "workspaces",
  id: "workspace-1",
  accountId: "account-1",
});
const operation = testOperation;

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
const applyState = testApplyState;

const initialApplyState = () => applyState<Projection>({});
const stringApplyState = () => applyState("");
const runStringOperations = (
  items: readonly Operation[],
  reduce: (projection: string, operation: Operation) => string,
) =>
  items.reduce<OperationApplyState<string>>(
    (state, item) => applyOperation(state, item, reduce),
    stringApplyState(),
  );
const sequentialOperation = (writerId: string, index: number) =>
  operation(
    writerId,
    BigInt(index),
    index === 1 ? {} : { [writerId]: BigInt(index - 1) },
    "x",
  );
const expectEquivocation = (
  state: OperationApplyState<Projection>,
  candidate: Operation,
  pattern: RegExp,
) => {
  expect(() => applyOperation(state, candidate, reducer)).toThrow(pattern);
};

const foldOperations = (
  count: number,
  make: (index: number) => Operation,
  reduce: typeof reducer,
  initial = initialApplyState(),
): OperationApplyState<Projection> => {
  let state = initial;
  for (let index = 0; index < count; index += 1)
    state = applyOperation(state, make(index), reduce);
  return state;
};
const measureAdmission = (
  count: number,
  initial: OperationApplyState<Projection>,
  make: (index: number) => Operation,
): {
  readonly duration: number;
  readonly state: OperationApplyState<Projection>;
} => {
  const started = performance.now();
  const state = foldOperations(count, make, reducer, initial);
  return { duration: performance.now() - started, state };
};
const applySequential = (count: number, reduce: typeof reducer) =>
  foldOperations(count, (index) => sequentialOperation("a", index + 1), reduce);
const waitingForGhost = () => {
  const first = operation("a", 1n, { ghost: 1n }, "one");
  return {
    first,
    waiting: applyOperation(initialApplyState(), first, reducer),
  };
};

const fillPending = (
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  reduce: typeof reducer,
): OperationApplyState<Projection> =>
  foldOperations(
    MAX_OPERATION_BATCH_SIZE,
    (index) => operation(`writer-${index.toString()}`, sequence, parents, "x"),
    reduce,
  );

describe("operation core", () => {
  test("converges concurrent non-commutative updates across arrival permutations", () => {
    const setPayloadValue = (_projection: string, item: Operation) => {
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
    const run = (items: readonly Operation[]) =>
      runStringOperations(items, setPayloadValue);
    expect(run([x, y]).projection).toBe(run([y, x]).projection);
    expect(run([x, y]).projection).toBe("Y");
  });

  test("converges causal chains and concurrent writers across arrival permutations", () => {
    const setOperationId = (_projection: string, item: Operation) =>
      item.operationId;
    const items = [
      operation("a", 1n, {}, "a1", 100),
      operation("a", 2n, { a: 1n }, "a2", 200),
      operation("b", 1n, {}, "b1", 50),
    ];
    const permutations = <T>(values: readonly T[]): T[][] =>
      values.length === 0
        ? [[]]
        : values.flatMap((value, index) =>
            permutations(
              values.filter((_, itemIndex) => itemIndex !== index),
            ).map((tail) => [value, ...tail]),
          );
    const run = (ordered: readonly Operation[]) =>
      runStringOperations(ordered, setOperationId);
    for (const ordered of permutations(items)) {
      const result = run(ordered);
      expect(result.projection).toBe("a-2");
      expect(result.frontier).toEqual({ a: 2n, b: 1n });
    }
  });

  test("replays again after a replay batch advances the last clock", () => {
    const appendClock = (projection: string, item: Operation) =>
      `${projection}${projection === "" ? "" : ","}${item.clock.physicalMs.toString()}`;
    const items = [
      operation("a", 1n, {}, "a", 100),
      operation("b", 1n, { z: 1n }, "b", 50),
      operation("c", 1n, { z: 1n }, "c", 600),
      operation("z", 1n, {}, "z", 10),
      operation("d", 1n, {}, "d", 200),
    ];

    expect(runStringOperations(items, appendClock).projection).toBe(
      "10,50,100,200,600",
    );
  });

  test("does not wedge after the former replay limit", () => {
    let state = initialApplyState();
    for (let index = 1; index <= 600; index += 1) {
      const sequence = BigInt(Math.ceil(index / 2));
      const writer = index % 2 === 0 ? "b" : "a";
      state = applyOperation(
        state,
        operation(
          writer,
          sequence,
          sequence === 1n ? {} : { [writer]: sequence - 1n },
          "x",
          index,
        ),
        reducer,
      );
    }
    expect(state.frontier).toEqual({ a: 300n, b: 300n });
  });

  test("distinguishes bigint and number operation fingerprints", () => {
    const first = createOperation({
      ...operation("a", 1n, { ghost: 1n }, "x"),
      payload: { value: 1n },
    });
    const waiting = applyOperation(initialApplyState(), first, reducer);
    expectEquivocation(
      waiting,
      { ...first, payload: { value: 1 } },
      /equivocation/,
    );
  });

  test("bounds never-ready admission without reducer work", () => {
    expect(MAX_OPERATION_BATCH_SIZE).toBe(512);
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
    const counter = countingReducer();
    const state = applySequential(800, counter.reduce);
    expect(counter.calls()).toBe(800);
    expect(state.replayCount).toBe(800);
  });

  test("admits a ready dependency into a full pending buffer and drains it", () => {
    const state = fillPending(2n, {}, reducer);
    const healed = applyOperation(
      state,
      operation("writer-0", 1n, {}, "one"),
      reducer,
    );
    expect(healed.frontier["writer-0"]).toBe(2n);
    expect(healed.pending).toHaveLength(MAX_OPERATION_BATCH_SIZE - 1);
  });

  test("omits undefined object properties but distinguishes null from non-finite numbers", () => {
    const { first } = waitingForGhost();
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
          entity: workspaceEntity(),
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
    const invalidPayloads = [
      [new Date(Number.NaN), /dates must be valid/],
      [new Map(), /must be plain/],
      [{ value: "x", [Symbol("x")]: "y" }, /string-keyed/],
    ] as const;
    for (const [payload, message] of invalidPayloads)
      expect(() => createOperation({ ...validationSeed, payload })).toThrow(
        message,
      );
    const shared = { value: "shared" };
    expect(
      createOperation({ ...validationSeed, payload: { a: shared, b: shared } })
        .payload,
    ).toEqual({ a: shared, b: shared });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      createOperation({ ...validationSeed, payload: cyclic }),
    ).toThrow(/must not be cyclic/);
    for (const unsupported of [() => undefined, Symbol("x")])
      expect(() =>
        createOperation({ ...validationSeed, payload: unsupported }),
      ).toThrow(/Unsupported operation value/);

    const cyclicApplyPayload: { self?: unknown } = {};
    cyclicApplyPayload.self = cyclicApplyPayload;
    const invalidApplyPayloads: Readonly<Record<string, unknown>> = {
      cyclic: cyclicApplyPayload,
      nonPlain: new Map(),
      nonFinite: { value: Number.NEGATIVE_INFINITY },
    };
    const invalidApplyMessages: Readonly<Record<string, RegExp>> = {
      cyclic: /must not be cyclic/,
      nonPlain: /must be plain/,
      nonFinite: /finite/,
    };
    for (const [kind, payload] of Object.entries(invalidApplyPayloads))
      expect(() =>
        applyOperation(
          initialApplyState(),
          { ...validationSeed, parents: {}, payload },
          reducer,
        ),
      ).toThrow(invalidApplyMessages[kind]);

    const dated = createOperation({
      ...validationSeed,
      payload: { at: new Date(1) },
    });
    const waiting = applyOperation(initialApplyState(), dated, reducer);
    const appliedDate = applyOperation(
      initialApplyState(),
      { ...dated, parents: {} },
      reducer,
    );
    const applied = materializeApplied(appliedDate.applied);
    expect("id:validator-1" in applied).toBe(true);
    expect(structuredClone(appliedDate.applied)).toEqual(appliedDate.applied);
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

  test("keeps never-ready admission below quadratic scaling", () => {
    const measure = (count: number) =>
      measureAdmission(count, initialApplyState(), (index) =>
        operation(`waiting-${index.toString()}`, 1n, { ghost: 1n }, "x"),
      );
    measure(64);
    const smaller = measure(128);
    const larger = measure(512);
    expect(larger.state.pending).toHaveLength(512);
    expect(larger.duration / smaller.duration).toBeLessThan(8);
  });

  test("keeps sequential admission below quadratic scaling", () => {
    const measure = (count: number): number => {
      const started = performance.now();
      const state = Array.from({ length: count }).reduce<
        OperationApplyState<number>
      >(
        (current, _, index) =>
          applyOperation(
            current,
            sequentialOperation("scale", index + 1),
            (value) => value + 1,
          ),
        testApplyState(0),
      );
      expect(state.projection).toBe(count);
      return performance.now() - started;
    };
    measure(500);
    const smaller = measure(4_000);
    const larger = measure(8_000);
    expect(larger / smaller).toBeLessThan(3.2);
  }, 20_000);

  test("retains every applied identity through treap rotations", () => {
    let state = initialApplyState();
    const operations = Array.from({ length: 200 }, (_, index) => {
      const suffix = index.toString();
      return operation(`writer-${suffix}`, 1n, {}, `value-${suffix}`);
    });
    for (const item of operations) state = applyOperation(state, item, reducer);
    expect(Object.keys(materializeApplied(state.applied)).sort()).toEqual(
      operations
        .flatMap((item) => [
          `id:${item.operationId}`,
          `writer:${item.writerId}:1`,
        ])
        .sort(),
    );
    expect(appliedIdentityDepth(state.applied)).toBeLessThanOrEqual(21);
    const original = operations[0];
    if (original === undefined) throw new Error("Missing operation fixture");
    expect(applyOperation(state, original, reducer)).toBe(state);
    const changed = { ...original, payload: { changed: true } };
    expect(() => applyOperation(state, changed, reducer)).toThrow(
      /equivocation/,
    );
  });

  test("preserves input states and resumes checkpoint-shaped durable state", () => {
    const original = initialApplyState();
    const first = applyOperation(
      original,
      operation("a", 1n, {}, "one"),
      reducer,
    );
    const branchOperation = operation("b", 1n, {}, "two");
    const branched = applyOperation(first, branchOperation, reducer);
    expect(Object.keys(materializeApplied(first.applied))).toHaveLength(2);
    expect(applyOperation(first, branchOperation, reducer)).not.toBe(first);
    expect(branched.frontier).toEqual({ a: 1n, b: 1n });
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
        ...stringApplyState(),
        projection: emptyProjection,
        baseProjection: emptyProjection,
      },
      operation("a", 1n, {}, "one"),
      (projection, item) => [...projection, item.operationId],
    );
    const checkpoint: OperationApplyState<readonly string[]> = {
      frontier: seeded.frontier,
      pending: [],
      projection: seeded.projection,
      applied: seeded.applied,
      replayHead: seeded.replayHead,
      replayCount: seeded.replayCount,
      replayLastClock: seeded.replayLastClock,
      baseProjection: seeded.baseProjection,
      baseFrontier: seeded.baseFrontier,
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
    const { first, waiting } = waitingForGhost();
    expectEquivocation(
      waiting,
      { ...first, operationId: "fresh", payload: { value: "changed" } },
      /writer:a:1/,
    );
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
    const coversAncestor = frontierCovers({ a: 2n }, { a: 1n });
    expect(coversAncestor).toBe(true);
    const causalFirst = operation("a", 1n, {}, "one");
    const second = operation("a", 2n, { a: 1n }, "two");
    const waiting = applyOperation(initialApplyState(), second, reducer);
    const applied = applyOperation(waiting, causalFirst, reducer);
    expect(applied.pending).toEqual([]);
    expect(applied.frontier).toEqual({ a: 2n });
    expect(applyOperation(applied, causalFirst, reducer)).toBe(applied);
    expectEquivocation(
      applied,
      { ...causalFirst, payload: { value: "changed" } },
      /equivocation/,
    );
  });
});
