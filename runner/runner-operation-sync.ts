import type { OperationPartition } from "../shared/operation-core.ts";
import { isPermanentOperationSynchronizationRejection } from "./runner-operation-transport.ts";

type OutboxRejection = readonly [
  ownerId: string,
  partition: OperationPartition,
  envelopes: readonly string[],
  reason: string,
];

interface OperationStore {
  readonly acknowledge: (
    ownerId: string,
    partition: OperationPartition,
    envelopes: readonly string[],
  ) => void;
  readonly apply: (
    ownerId: string,
    partition: OperationPartition,
    envelopes: readonly string[],
    source: "remote",
  ) => void;
  readonly pending: (
    ownerId: string,
    partition: OperationPartition,
  ) => readonly string[];
  readonly rejectOutbox: (...rejection: OutboxRejection) => void;
  readonly state: (
    ownerId: string,
    partition: OperationPartition,
  ) => {
    readonly frontier: Readonly<Record<string, bigint>>;
    readonly stalled?: boolean;
  };
}
interface OperationTransport {
  readonly readPage: (request: RunnerOperationRead) => Promise<{
    readonly envelopes: readonly string[];
    readonly hasMore: boolean;
  }>;
  readonly writeBatch: (
    partition: OperationPartition,
    envelopes: readonly string[],
    signal: AbortSignal,
  ) => Promise<void>;
}

const partitions = ["non-session", "session"] as const;

export interface RunnerOperationRead {
  readonly frontier: Readonly<Record<string, bigint>>;
  readonly partition: OperationPartition;
  readonly signal: AbortSignal;
}

const ownerAlias = "self";
const synchronizePartition = async (request: {
  readonly partition: OperationPartition;
  readonly signal: AbortSignal;
  readonly store: OperationStore;
  readonly transport: OperationTransport;
}): Promise<void> => {
  const { partition, signal, store, transport } = request;
  const pending = store.pending(ownerAlias, partition);
  if (pending.length > 0) {
    try {
      await transport.writeBatch(partition, pending, signal);
      store.acknowledge(ownerAlias, partition, pending);
    } catch (error) {
      if (!isPermanentOperationSynchronizationRejection(error)) throw error;
      store.rejectOutbox(ownerAlias, partition, pending, error.message);
    }
  }
  let hasMore: boolean;
  do {
    const page = await transport.readPage({
      signal,
      partition,
      frontier: store.state(ownerAlias, partition).frontier,
    });
    if (page.envelopes.length > 0) {
      store.apply(ownerAlias, partition, page.envelopes, "remote");
      if (store.state(ownerAlias, partition).stalled)
        throw new Error(
          `Operation synchronization partition stalled: ${partition}`,
        );
    }
    hasMore = page.hasMore;
  } while (hasMore);
};

export const synchronizeRunnerOperations = async (
  store: OperationStore,
  transport: OperationTransport,
  signal: AbortSignal,
): Promise<void> => {
  const results = await Promise.allSettled(
    partitions.map((partition) =>
      synchronizePartition({ partition, signal, store, transport }),
    ),
  );
  const failures: unknown[] = [];
  for (const result of results)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length === partitions.length) throw failures[0];
};
