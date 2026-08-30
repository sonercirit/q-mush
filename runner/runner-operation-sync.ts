import type { OperationPartition } from "../shared/operation-core.ts";

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
  readonly state: (
    ownerId: string,
    partition: OperationPartition,
  ) => { readonly frontier: Readonly<Record<string, bigint>> };
}
interface OperationTransport {
  readonly pull: (
    partition: OperationPartition,
    frontier: Readonly<Record<string, bigint>>,
    signal: AbortSignal,
  ) => Promise<{
    readonly envelopes: readonly string[];
    readonly hasMore: boolean;
  }>;
  readonly push: (
    partition: OperationPartition,
    envelopes: readonly string[],
    signal: AbortSignal,
  ) => Promise<void>;
}

const partitions = ["non-session", "session"] as const;

export const synchronizeRunnerOperations = async (
  store: OperationStore,
  transport: OperationTransport,
  signal: AbortSignal,
): Promise<void> => {
  for (const partition of partitions) {
    const pending = store.pending("self", partition);
    if (pending.length > 0) {
      await transport.push(partition, pending, signal);
      store.acknowledge("self", partition, pending);
    }
    let hasMore: boolean;
    do {
      const page = await transport.pull(
        partition,
        store.state("self", partition).frontier,
        signal,
      );
      store.apply("self", partition, page.envelopes, "remote");
      hasMore = page.hasMore;
    } while (hasMore);
  }
};
