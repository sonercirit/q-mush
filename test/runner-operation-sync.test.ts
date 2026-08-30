import { Database } from "bun:sqlite";
import { expect, test } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store.ts";
import { synchronizeRunnerOperations } from "../runner/runner-operation-sync.ts";
import { encodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type { OperationPartition } from "../shared/operation-core.ts";
import { createOperationStore } from "../sync-engine/operation-store.ts";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization.ts";
import { testOperation } from "./operation-core-test-support.ts";
import { createOperationDatabaseHarness } from "./operation-store-test-support.ts";

interface HarnessState {
  frontier: Readonly<Record<string, bigint>>;
  pending: readonly string[];
  stalled: boolean;
  outboxStalls: readonly {
    readonly operationId: string;
    readonly reason: string;
  }[];
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
        _ownerId: string,
        _partition: OperationPartition,
        envelopes: readonly string[],
      ) => {
        events.push("ack");
        state.pending = state.pending.filter(
          (pending) => !envelopes.includes(pending),
        );
      },
      apply: (
        _ownerId: string,
        _partition: OperationPartition,
        envelopes: readonly string[],
      ) => {
        const poisoned = envelopes.some((envelope) => envelope === "poison");
        if (poisoned) state.stalled = true;
        events.push(`apply:${envelopes.join(",")}`);
        if (poisoned) return;
        state.frontier = {
          writer: (state.frontier["writer"] ?? 0n) + BigInt(envelopes.length),
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
        state.outboxStalls = [{ operationId: envelope, reason }];
      },
      state: () => ({
        frontier: state.frontier,
        stalled: state.stalled,
        outboxStalls: state.outboxStalls,
      }),
    },
  };
};

const runSynchronization = (
  replica: ReturnType<typeof harness>,
  transport: Parameters<typeof synchronizeRunnerOperations>[1],
) =>
  synchronizeRunnerOperations(
    replica.store,
    transport,
    new AbortController().signal,
  );

const pendingForNonSession = (
  store: ReturnType<typeof createRunnerOperationStore>,
) => store.pending("self", "non-session");
const noEnvelopes: readonly string[] = [];
const emptyPage = () =>
  Promise.resolve({ envelopes: noEnvelopes, hasMore: false });
const ownedEngineOperation = <Operation extends ReturnType<typeof testOperation>>(
  operation: Operation,
): Operation =>
  Object.assign(operation, {
    entity: { ...operation.entity, accountId: "owner-1" },
  });
const engineOwnedEnvelope = () => {
  const operation = testOperation("owner-1", 1n, {}, "local", Date.now());
  return encodeOperationEnvelope(ownedEngineOperation(operation));
};
const resolvedWrite = () => Promise.resolve(undefined);
const emptyTransport = (
  writeBatch: Parameters<typeof synchronizeRunnerOperations>[1]["writeBatch"],
) => ({ writeBatch, readPage: emptyPage });

const expectOutboxRetained = (
  replica: ReturnType<typeof harness>,
  expected: readonly string[],
) => {
  expect(replica.state.pending).toEqual(expected);
  expect(replica.events).toEqual([]);
};

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
          : emptyPage();
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

test("isolates a batch 400, commits good neighbors, and durably stalls without discarding poison", async () => {
  const engine = createOperationDatabaseHarness();
  const resources = engine.setup();
  const handler = createOperationSynchronization(
    resources.database,
    { authenticatedUser: () => null },
    undefined,
    { runnerAccount: () => ({ userId: "owner-1" }) },
  );
  const runnerDatabase = new Database(":memory:");
  try {
    const store = createRunnerOperationStore(runnerDatabase);
    const now = Date.now();
    const encoded = [
      encodeOperationEnvelope(
        ownedEngineOperation(testOperation("owner-1", 1n, {}, "good-1", now)),
      ),
      encodeOperationEnvelope(
        ownedEngineOperation(
          testOperation("owner-1", 2n, { "owner-1": 1n }, "good-2", now + 1),
        ),
      ),
      encodeOperationEnvelope(
        ownedEngineOperation(
          testOperation(
            "owner-1",
            3n,
            { "owner-1": 2n },
            "clock-skew",
            now + 7 * 24 * 60 * 60 * 1_000,
          ),
        ),
      ),
    ];
    store.apply("self", "non-session", encoded, "local");
    const writes: number[] = [];
    const transport = {
      async writeBatch(
        partition: OperationPartition,
        envelopes: readonly string[],
      ) {
        writes.push(envelopes.length);
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
      },
      readPage: () => emptyPage(),
    };

    await expect(
      synchronizeRunnerOperations(
        store,
        transport,
        new AbortController().signal,
      ),
    ).rejects.toThrow("outbox stalled");
    expect(writes).toEqual([3, 1, 1, 1]);
    expect(pendingForNonSession(store)).toEqual([encoded[2]]);
    expect(store.state("self", "non-session").outboxStalls).toEqual([
      expect.objectContaining({ operationId: "owner-1-3" }),
    ]);
    expect(
      createOperationStore({ database: resources.database }).readEncodedEnvelopes(
        "owner-1",
        "non-session",
        {},
        10,
      ).envelopes,
    ).toEqual(encoded.slice(0, 2));
  } finally {
    runnerDatabase.close();
    engine.close();
  }
});

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
        return emptyPage();
      },
    }),
  ).rejects.toThrow("outbox stalled");
  expect(replica.events).toEqual([
    "ack",
    "ack",
    "stall:poison:protocol rejected",
    "stall:poison:protocol rejected",
    "ack",
    "ack",
  ]);
  expect(replica.state.pending).toEqual(["poison"]);
  expect(replica.state.outboxStalls).toEqual([
    { operationId: "poison", reason: "protocol rejected" },
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
  const engine = createOperationDatabaseHarness();
  const resources = engine.setup();
  const handler = createOperationSynchronization(
    resources.database,
    { authenticatedUser: () => null },
    undefined,
    { runnerAccount: () => ({ userId: "owner-1" }) },
  );
  const runnerDatabase = new Database(":memory:");
  try {
    const store = createRunnerOperationStore(runnerDatabase);
    const encoded = engineOwnedEnvelope();
    store.apply("self", "non-session", [encoded], "local");
    let pushes = 0;
    const transport = {
      async writeBatch(
        partition: OperationPartition,
        envelopes: readonly string[],
      ) {
        pushes += 1;
        const response = await handler(
          new Request("http://engine.test/api/operations/synchronize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ownerId: "self", partition, envelopes }),
          }),
        );
        expect(response.status).toBe(200);
        if (pushes === 1) throw new Error("ack dropped");
      },
      readPage: () => emptyPage(),
    };
    const synchronize = () =>
      synchronizeRunnerOperations(
        store,
        transport,
        new AbortController().signal,
      );
    await expect(synchronize()).rejects.toThrow("ack dropped");
    expect(pendingForNonSession(store)).toEqual([encoded]);
    await synchronize();
    expect(pendingForNonSession(store)).toEqual([]);
    expect(pushes).toBe(2);
    expect(
      createOperationStore({
        database: resources.database,
      }).readEncodedEnvelopes("owner-1", "non-session", {}, 10).envelopes,
    ).toEqual([encoded]);
  } finally {
    runnerDatabase.close();
    engine.close();
  }
});

test("acknowledges pushed outbox only after transport success", async () => {
  const successful = harness({ pending: ["local"] });
  await synchronizeRunnerOperations(
    successful.store,
    {
      writeBatch: () => Promise.resolve(),
      readPage: emptyPage,
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
        readPage: emptyPage,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("offline");
  expect(replica.events).toEqual([]);
  expect(replica.state.pending).toEqual(["local"]);
});
