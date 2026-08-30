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
}
const harness = (initial: Partial<HarnessState> = {}) => {
  const state: HarnessState = {
    frontier: initial.frontier ?? {},
    stalled: initial.stalled ?? false,
    pending: initial.pending ?? [],
  };
  const events: string[] = [];
  return {
    events,
    state,
    store: {
      acknowledge: () => {
        events.push("ack");
        state.pending = [];
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
      rejectOutbox: (...rejection: readonly unknown[]) => {
        const reason = rejection.at(-1);
        events.push(`reject:${String(reason)}`);
        state.pending = [];
      },
      state: () => ({ frontier: state.frontier, stalled: state.stalled }),
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
const engineOwnedEnvelope = () => {
  const operation = testOperation("owner-1", 1n, {}, "local", Date.now());
  return encodeOperationEnvelope(
    Object.assign(operation, {
      entity: { ...operation.entity, accountId: "owner-1" },
    }),
  );
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
  await runSynchronization(harness(), {
    readPage: ({ partition }) => {
      partitions.push(partition);
      return partition === "non-session"
        ? Promise.reject(new Error("poisoned partition"))
        : emptyPage();
    },
    writeBatch: resolvedWrite,
  });
  expect(partitions.join(",")).toBe("non-session,session");
});

test("a durably stalled partition leaves its frontier fixed while its peer completes", async () => {
  const replica = harness();
  const reads: OperationPartition[] = [];
  await runSynchronization(replica, {
    readPage: ({ partition }) => {
      reads.push(partition);
      return Promise.resolve({
        envelopes: partition === "non-session" ? ["poison"] : noEnvelopes,
        hasMore: partition === "non-session",
      });
    },
    writeBatch: resolvedWrite,
  });
  expect(reads).toEqual(["non-session", "session"]);
  expect(replica.state.frontier).toEqual({});
});

test("sets aside a permanently rejected outbox batch and continues pulling", async () => {
  const replica = harness({ pending: ["poison"] });
  const rejected = Object.assign(new Error("protocol rejected"), {
    operationSynchronizationStatus: 400,
  });
  await runSynchronization(replica, {
    writeBatch: () => Promise.reject(rejected),
    readPage: emptyPage,
  });
  expect(replica.events).toEqual([
    "reject:protocol rejected",
    "reject:protocol rejected",
  ]);
  expect(replica.state.pending).toEqual([]);
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
    await synchronize();
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
