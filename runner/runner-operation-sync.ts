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

export const synchronizeRunnerOperations = async (
  store: OperationStore,
  transport: OperationTransport,
  signal: AbortSignal,
): Promise<void> => {
  for (const partition of partitions) {
    const pending = store.pending("self", partition);
    if (pending.length > 0) {
      await transport.writeBatch(partition, pending, signal);
      store.acknowledge("self", partition, pending);
    }
    let hasMore: boolean;
    do {
      const page = await transport.readPage({
        signal,
        partition,
        frontier: store.state("self", partition).frontier,
      });
      store.apply("self", partition, page.envelopes, "remote");
      hasMore = page.hasMore;
    } while (hasMore);
  }
};
