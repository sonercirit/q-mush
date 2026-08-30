import { expect, test } from "vitest";

import { synchronizeRunnerOperations } from "../runner/runner-operation-sync.ts";
import type { OperationPartition } from "../shared/operation-core.ts";

interface HarnessState {
  frontier: Readonly<Record<string, bigint>>;
  pending: readonly string[];
}
const harness = (initial: Partial<HarnessState> = {}) => {
  const state: HarnessState = {
    frontier: initial.frontier ?? {},
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
        events.push(`apply:${envelopes.join(",")}`);
        state.frontier = {
          writer: (state.frontier["writer"] ?? 0n) + BigInt(envelopes.length),
        };
      },
      pending: () => state.pending,
      state: () => ({ frontier: state.frontier }),
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

const noEnvelopes: readonly string[] = [];
const emptyPage = () =>
  Promise.resolve({ envelopes: noEnvelopes, hasMore: false });

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
  await runSynchronization(replica, {
    writeBatch: () => Promise.resolve(undefined),
    readPage: emptyPage,
  });
  expect(replica.events).toEqual([]);
});

test("continues the other partition after one partition fails", async () => {
  const replica = harness();
  const partitions: OperationPartition[] = [];
  await runSynchronization(replica, {
    readPage: ({ partition }) => {
      partitions.push(partition);
      return partition === "non-session"
        ? Promise.reject(new Error("poisoned partition"))
        : emptyPage();
    },
    writeBatch: () => Promise.resolve(undefined),
  });
  expect(partitions).toEqual(["non-session", "session"]);
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
