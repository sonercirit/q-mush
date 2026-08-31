import { Database } from "bun:sqlite";
import { expect, test, vi } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store.ts";
import { synchronizeRunnerOperations } from "../runner/runner-operation-sync.ts";
import { createRunnerOperationTransport } from "../runner/runner-operation-transport.ts";
import {
  decodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint.ts";
import type { OperationPartition } from "../shared/operation-core.ts";
import { operationEntityProjectionCodec } from "../shared/operation-projection.ts";
import { createOperationStore } from "../sync-engine/operation-store.ts";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization.ts";
import { testOperation } from "./operation-core-test-support.ts";
import { createOperationDatabaseHarness } from "./operation-store-test-support.ts";

type OutboxStall = NonNullable<
  ReturnType<
    ReturnType<typeof createRunnerOperationStore>["state"]
  >["outboxStalls"]
>[number];
interface HarnessState {
  frontier: Readonly<Record<string, bigint>>;
  pending: readonly string[];
  stalled: boolean;
  outboxStalls: readonly OutboxStall[];
}
const harness = (initial: Partial<HarnessState> = {}) => {
  const state: HarnessState = {
    frontier: initial.frontier ?? {},
    stalled: initial.stalled ?? false,
    pending: initial.pending ?? [],
    outboxStalls: initial.outboxStalls ?? [],
  };
  const events: string[] = [];
  return {
    events,
    state,
    store: {
      acknowledge: (
        _owner: string,
        _scope: OperationPartition,
        acknowledged: readonly string[],
      ) => {
        events.push("ack");
        state.pending = state.pending.filter(
          (pending) => !acknowledged.includes(pending),
        );
      },
      apply: (
        _ownerId: string,
        _partition: OperationPartition,
        incoming: readonly string[],
      ) => {
        void _ownerId;
        const poisoned = incoming.some((envelope) => envelope === "poison");
        if (poisoned) state.stalled = true;
        events.push(`apply:${incoming.join(",")}`);
        if (poisoned) return;
        state.frontier = {
          writer: (state.frontier["writer"] ?? 0n) + BigInt(incoming.length),
        };
      },
      pending: () => state.pending,
      stallOutbox: (
        _ownerId: string,
        _partition: OperationPartition,
        envelope: string,
        reason: string,
      ) => {
        events.push(`stall:${envelope}:${reason}`);
        state.outboxStalls = [
          {
            operationId: envelope,
            queuedBehind: 0,
            reason,
            writerId: "unknown-writer",
          },
        ];
      },
      state: () => ({
        frontier: state.frontier,
        stalled: state.stalled,
        outboxStalls: state.outboxStalls,
      }),
    },
  };
};

const synchronizeStore = (
  store: Parameters<typeof synchronizeRunnerOperations>[0],
  transport: Parameters<typeof synchronizeRunnerOperations>[1],
) =>
  synchronizeRunnerOperations(store, transport, new AbortController().signal);
const runSynchronization = (
  replica: ReturnType<typeof harness>,
  transport: Parameters<typeof synchronizeRunnerOperations>[1],
) => synchronizeStore(replica.store, transport);

const engineHarness = () => {
  const engine = createOperationDatabaseHarness();
  const resources = engine.setup();
  return {
    engine,
    resources,
    handler: createOperationSynchronization(
      resources.database,
      { authenticatedUser: () => null },
      undefined,
      { runnerAccount: () => ({ userId: "owner-1" }) },
    ),
  };
};
const postToEngine = async (
  handler: ReturnType<typeof createOperationSynchronization>,
  partition: OperationPartition,
  envelopes: readonly string[],
): Promise<Response> => {
  const response = await handler(
    new Request("http://engine.test/api/operations/synchronize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerId: "self", partition, envelopes }),
    }),
  );
  if (!response.ok)
    throw Object.assign(new Error(`HTTP ${String(response.status)}`), {
      operationSynchronizationStatus: response.status,
    });
  return response;
};
const engineEnvelopes = (
  database: Parameters<typeof createOperationStore>[0]["database"],
) =>
  createOperationStore({ database }).readEncodedEnvelopes(
    "owner-1",
    "non-session",
    {},
    10,
  ).envelopes;
interface EngineRunnerContext {
  readonly engineDatabase: Parameters<
    typeof createOperationStore
  >[0]["database"];
  readonly handler: ReturnType<typeof createOperationSynchronization>;
  readonly store: ReturnType<typeof createRunnerOperationStore>;
}
const withEngineAndRunner = async (
  run: (context: EngineRunnerContext) => Promise<void>,
) => {
  const { engine, handler, resources } = engineHarness();
  const runner = new Database(":memory:");
  try {
    await run({
      engineDatabase: resources.database,
      handler,
      store: createRunnerOperationStore(runner),
    });
  } finally {
    runner.close();
    engine.close();
  }
};
const engineRunnerTest = (
  name: string,
  run: (
    context: EngineRunnerContext & { readonly now: number },
  ) => Promise<void>,
): void => {
  test(name, async () => {
    await withEngineAndRunner((context) =>
      run({ ...context, now: Date.now() }),
    );
  });
};
const pendingForNonSession = (
  store: ReturnType<typeof createRunnerOperationStore>,
) => store.pending("self", "non-session");
const noEnvelopes: string[] = [];
const page = () => Promise.resolve({ envelopes: noEnvelopes, hasMore: false });
const ownedEngineOperation = <
  Operation extends ReturnType<typeof testOperation>,
>(
  operation: Operation,
): Operation =>
  Object.assign(operation, {
    entity: { ...operation.entity, accountId: "owner-1" },
  });
const ownedEngineEnvelope = (
  sequence: bigint,
  dependencies: Readonly<Record<string, bigint>>,
  value: string,
  timestamp: number,
) =>
  encodeOperationEnvelope(
    ownedEngineOperation(
      testOperation("owner-1", sequence, dependencies, value, timestamp),
    ),
  );
const engineOwnedEnvelope = () =>
  ownedEngineEnvelope(1n, {}, "local", Date.now());
const resolvedWrite = () => Promise.resolve();
const emptyTransport = (
  writeBatch: Parameters<typeof synchronizeRunnerOperations>[1]["writeBatch"],
) => ({ writeBatch, readPage: page });
const engineTransport = (
  handler: ReturnType<typeof createOperationSynchronization>,
  beforeWrite: (batch: readonly string[]) => void | Promise<void>,
) => ({
  writeBatch: async (
    partition: OperationPartition,
    batch: readonly string[],
  ) => {
    await beforeWrite(batch);
    await postToEngine(handler, partition, batch);
  },
  readPage: page,
});

const recordingEngineTransport = (
  handler: ReturnType<typeof createOperationSynchronization>,
  writes: number[],
) =>
  engineTransport(handler, (batch) => {
    writes.push(batch.length);
  });

const expectError = (value: unknown): Error => {
  expect(value).toBeInstanceOf(Error);
  if (!(value instanceof Error)) throw new Error("Expected an Error");
  return value;
};
const captureError = async (promise: Promise<unknown>): Promise<Error> =>
  expectError(await promise.catch((reason: unknown) => reason));
const transport = createRunnerOperationTransport("http://e", "t");
const signal = () => new AbortController().signal;
const readRunnerPage = () =>
  transport.readPage({
    frontier: {},
    partition: "non-session",
    signal: signal(),
  });
const writeEncoded = () =>
  transport.writeBatch("non-session", ["encoded"], signal());
const rejectedStall = (operationId: string, writerId: string): OutboxStall => ({
  operationId,
  queuedBehind: 0,
  reason: "rejected",
  writerId,
});
const expectOutboxRetained = (
  replica: ReturnType<typeof harness>,
  expected: readonly string[],
) => {
  expect(replica.state.pending).toEqual(expected);
  expect(replica.events).toEqual([]);
};

const malformedPage = (stableClock: unknown, stableFrontier: unknown) =>
  Response.json({
    envelopes: [],
    hasMore: false,
    stableClock,
    stableFrontier,
  });

test("transport defaults absent stability and rejects malformed stability", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    fetchMock.mockResolvedValueOnce(
      Response.json({ envelopes: [], hasMore: false }),
    );
    await expect(readRunnerPage()).resolves.toMatchObject({
      stableClock: null,
      stableFrontier: null,
    });
    for (const [clock, frontier] of [
      [{ physicalMs: -1, logical: 0, writerId: "a" }, { a: "1" }],
      [{ physicalMs: 1, logical: 0, writerId: "a" }, { a: { toString: "x" } }],
    ] as const) {
      fetchMock.mockResolvedValueOnce(malformedPage(clock, frontier));
      await expect(readRunnerPage()).rejects.toThrow(/stability/);
    }
  } finally {
    fetchMock.mockRestore();
  }
});

test("captures only a bounded engine rejection reason", async () => {
  const detail = `safe reason ${"x".repeat(1_000)}`;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ error: detail }), { status: 400 }),
    );
  try {
    const message = (await captureError(writeEncoded())).message;
    expect(message).toContain("safe reason");
    expect(message.length).toBeLessThan(460);
    expect(message).not.toContain("x".repeat(500));
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    fetchMock.mockRestore();
  }
});

test("stops reading an oversized streamed engine rejection", async () => {
  const cancel = vi.fn();
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(1_024).fill(120));
    },
  );
  const body = new ReadableStream<Uint8Array>({ cancel, pull });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body, { status: 400 }));
  try {
    await expect(writeEncoded()).rejects.toThrow(
      "Operation synchronization failed (400)",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull.mock.calls.length).toBeLessThan(10);
  } finally {
    fetchMock.mockRestore();
  }
});

test("bounds reported stall identities while retaining total depth", async () => {
  const longOperationId = `operation-${"x".repeat(1_000)}`;
  const replica = harness({
    pending: [],
    outboxStalls: Array.from({ length: 512 }, (_, index) =>
      rejectedStall(
        index === 0
          ? longOperationId
          : `operation-${String(index).padStart(3, "0")}`,
        `writer-${String(index)}`,
      ),
    ),
  });
  const message = (
    await captureError(
      runSynchronization(replica, emptyTransport(resolvedWrite)),
    )
  ).message;
  expect(message).toContain(`${longOperationId.slice(0, 64)}…`);
  expect(message).not.toContain(longOperationId.slice(0, 66));
  expect(message).toContain("operation-001");
  expect(message).toContain("+507 more");
  expect(message).toContain("512 stalled");
  expect(message.length).toBeLessThan(500);
  expect(message).not.toContain("operation-006");
});

test("resumes pull pages from each durably applied frontier", async () => {
  const replica = harness();
  const frontiers: bigint[] = [];
  let page = 0;
  await runSynchronization(replica, {
    readPage: ({ frontier }) => {
      frontiers.push(frontier["writer"] ?? 0n);
      page += 1;
      return Promise.resolve({
        envelopes: page === 1 ? ["one"] : page === 2 ? ["two"] : noEnvelopes,
        hasMore: page < 2,
      });
    },
    writeBatch: () => Promise.resolve(),
  });
  expect(frontiers).toEqual([0n, 0n, 1n]);
  expect(replica.events).toEqual(["apply:one", "apply:two"]);
});

test("skips empty pages without opening store writes", async () => {
  const replica = harness();
  await runSynchronization(replica, emptyTransport(resolvedWrite));
  expect(replica.events).toEqual([]);
});

test("continues the other partition after one partition fails", async () => {
  const partitions: OperationPartition[] = [];
  await expect(
    runSynchronization(harness(), {
      readPage: ({ partition }) => {
        partitions.push(partition);
        return partition === "non-session"
          ? Promise.reject(new Error("poisoned partition"))
          : page();
      },
      writeBatch: resolvedWrite,
    }),
  ).rejects.toThrow("poisoned partition");
  expect(partitions.join(",")).toBe("non-session,session");
});

test("a durably stalled partition leaves its frontier fixed while its peer completes", async () => {
  const replica = harness();
  const reads: OperationPartition[] = [];
  await expect(
    runSynchronization(replica, {
      readPage: ({ partition }) => {
        reads.push(partition);
        return Promise.resolve({
          envelopes: partition === "non-session" ? ["poison"] : noEnvelopes,
          hasMore: partition === "non-session",
        });
      },
      writeBatch: resolvedWrite,
    }),
  ).rejects.toThrow("partition stalled");
  expect(reads).toEqual(["non-session", "session"]);
  expect(replica.state.frontier).toEqual({});
});

engineRunnerTest(
  "a permanent head poison never pushes or acknowledges causal successors",
  async ({ engineDatabase, handler, now, store }) => {
    const encoded = [
      ownedEngineEnvelope(
        1n,
        {},
        "past-poison",
        now - 7 * 24 * 60 * 60 * 1_000,
      ),
      ownedEngineEnvelope(2n, { "owner-1": 1n }, "good-2", now),
      ownedEngineEnvelope(3n, { "owner-1": 2n }, "good-3", now + 1),
    ];
    store.apply("self", "non-session", encoded, "local");
    const writes: number[] = [];
    const transport = recordingEngineTransport(handler, writes);
    for (let cycle = 0; cycle < 3; cycle += 1)
      await expect(synchronizeStore(store, transport)).rejects.toThrow(
        /outbox stalled.*2 queued behind/,
      );
    expect(writes).toEqual([3, 1, 1, 1]);
    expect(pendingForNonSession(store)).toEqual(encoded);
    expect(store.state("self", "non-session").outboxStalls).toEqual([
      expect.objectContaining({ operationId: "owner-1-1", queuedBehind: 2 }),
    ]);
    expect(engineEnvelopes(engineDatabase)).toEqual([]);
  },
);

engineRunnerTest(
  "a permanent head bounds retries and drains all successors in order after repair",
  async ({ engineDatabase, handler, now, store }) => {
    const encoded = Array.from({ length: 9 }, (_, index) => {
      const sequence = BigInt(index + 1);
      return ownedEngineEnvelope(
        sequence,
        sequence === 1n ? {} : { "owner-1": sequence - 1n },
        `value-${String(sequence)}`,
        now + index,
      );
    });
    store.apply("self", "non-session", encoded.slice(0, 3), "local");
    let rejectHead = true;
    const writesByCycle: number[][] = [];
    let cycleWrites: number[] = [];
    const transport = engineTransport(handler, (batch) => {
      cycleWrites.push(batch.length);
      if (rejectHead && batch.includes(encoded[0] ?? ""))
        throw Object.assign(new Error("injected permanent rejection"), {
          operationSynchronizationStatus: 400,
        });
    });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      if (cycle > 0)
        store.apply(
          "self",
          "non-session",
          encoded.slice(cycle * 3, cycle * 3 + 3),
          "local",
        );
      cycleWrites = [];
      await expect(synchronizeStore(store, transport)).rejects.toThrow(
        new RegExp(`${String((cycle + 1) * 3 - 1)} queued behind`),
      );
      writesByCycle.push(cycleWrites);
      expect(store.state("self", "non-session").outboxStalls).toHaveLength(1);
      expect(engineEnvelopes(engineDatabase)).toEqual([]);
    }
    expect(writesByCycle).toEqual([[3, 1], [1], [1]]);
    rejectHead = false;
    cycleWrites = [];
    await synchronizeStore(store, transport);
    expect(cycleWrites).toEqual([1, 8]);
    expect(pendingForNonSession(store)).toEqual([]);
    expect(store.state("self", "non-session").outboxStalls).toEqual([]);
    expect(engineEnvelopes(engineDatabase)).toEqual(encoded);
    const checkpoint = decodeOperationCheckpoint(
      createOperationStore({ database: engineDatabase }).loadCheckpoint(
        "owner-1",
        "non-session",
      ) ?? "",
      operationEntityProjectionCodec,
    );
    expect(checkpoint.frontier).toEqual({ "owner-1": 9n });
    expect(checkpoint.pending).toEqual([]);
  },
);

test("a batch 400 stalls only rejected singles, retains them, and continues pulling", async () => {
  const replica = harness({ pending: ["good", "poison", "also-good"] });
  const rejected = Object.assign(new Error("protocol rejected"), {
    operationSynchronizationStatus: 400,
  });
  const pulls: OperationPartition[] = [];
  await expect(
    runSynchronization(replica, {
      writeBatch: (_partition, envelopes) =>
        envelopes.length > 1 || envelopes[0] === "poison"
          ? Promise.reject(rejected)
          : Promise.resolve(),
      readPage: ({ partition }) => {
        pulls.push(partition);
        return page();
      },
    }),
  ).rejects.toThrow("outbox stalled");
  expect(replica.events).toEqual([
    "ack",
    "ack",
    "stall:poison:protocol rejected",
    "stall:poison:protocol rejected",
  ]);
  expect(replica.state.pending).toEqual(["poison", "also-good"]);
  expect(replica.state.outboxStalls).toEqual([
    {
      operationId: "poison",
      queuedBehind: 0,
      reason: "protocol rejected",
      writerId: "unknown-writer",
    },
  ]);
  expect(pulls).toEqual(["non-session", "session"]);
});

test("retains capacity-rejected outbox entries for retry", async () => {
  const replica = harness({ pending: ["large"] });
  const capacity = Object.assign(new Error("capacity"), {
    operationSynchronizationStatus: 507,
  });
  await expect(
    runSynchronization(
      replica,
      emptyTransport(() => Promise.reject(capacity)),
    ),
  ).rejects.toThrow("capacity");
  expectOutboxRetained(replica, ["large"]);
});

test("re-pushes idempotently after engine commit and a dropped local acknowledgement", async () => {
  await withEngineAndRunner(async (context) => {
    const encoded = engineOwnedEnvelope();
    context.store.apply("self", "non-session", [encoded], "local");
    let pushes = 0;
    const pushAfterCommit = async (
      scope: OperationPartition,
      batch: readonly string[],
    ) => {
      pushes += 1;
      const response = await postToEngine(context.handler, scope, batch);
      expect(response.status).toBe(200);
      if (pushes === 1) throw new Error("ack dropped");
    };
    const transport = {
      writeBatch: pushAfterCommit,
      readPage: page,
    };
    const synchronize = () => synchronizeStore(context.store, transport);
    await expect(synchronize()).rejects.toThrow("ack dropped");
    expect(pendingForNonSession(context.store)).toEqual([encoded]);
    await synchronize();
    expect(pendingForNonSession(context.store)).toEqual([]);
    expect(pushes).toBe(2);
    expect(engineEnvelopes(context.engineDatabase)).toEqual([encoded]);
  });
});

test("acknowledges pushed outbox only after transport success", async () => {
  const successful = harness({ pending: ["local"] });
  await synchronizeRunnerOperations(
    successful.store,
    {
      writeBatch: () => Promise.resolve(),
      readPage: page,
    },
    new AbortController().signal,
  );
  expect(successful.events[0]).toBe("ack");
  expect(successful.state.pending).toEqual([]);

  const replica = harness({ pending: ["local"] });
  const offline = new Error("offline");
  await expect(
    synchronizeRunnerOperations(
      replica.store,
      {
        writeBatch: () => Promise.reject(offline),
        readPage: page,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("offline");
  expect(replica.events).toEqual([]);
  expect(replica.state.pending).toEqual(["local"]);
});
