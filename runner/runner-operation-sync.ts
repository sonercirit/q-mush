import { decodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type { OperationPartition } from "../shared/operation-core.ts";
import { isOperationSynchronizationBadRequest } from "./runner-operation-transport.ts";

interface OutboxStall {
  readonly operationId: string;
  readonly reason: string;
}
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
  readonly stallOutbox: (
    ownerId: string,
    partition: OperationPartition,
    envelope: string,
    reason: string,
  ) => void;
  readonly state: (
    ownerId: string,
    partition: OperationPartition,
  ) => {
    readonly frontier: Readonly<Record<string, bigint>>;
    readonly stalled?: boolean;
    readonly outboxStalls?: readonly OutboxStall[];
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
const outboxIdentity = (encoded: string): string => {
  try {
    return decodeOperationEnvelope(encoded).operationId;
  } catch {
    return encoded;
  }
};
const pushSinglyAfterBadRequest = async (request: {
  readonly envelopes: readonly string[];
  readonly partition: OperationPartition;
  readonly signal: AbortSignal;
  readonly store: OperationStore;
  readonly transport: OperationTransport;
}): Promise<boolean> => {
  let stalled = false;
  for (const envelope of request.envelopes) {
    try {
      await request.transport.writeBatch(
        request.partition,
        [envelope],
        request.signal,
      );
      request.store.acknowledge(ownerAlias, request.partition, [envelope]);
    } catch (error) {
      if (!isOperationSynchronizationBadRequest(error)) throw error;
      request.store.stallOutbox(
        ownerAlias,
        request.partition,
        envelope,
        error.message,
      );
      stalled = true;
    }
  }
  return stalled;
};
const pushOutbox = async (request: {
  readonly partition: OperationPartition;
  readonly signal: AbortSignal;
  readonly store: OperationStore;
  readonly transport: OperationTransport;
}): Promise<boolean> => {
  const { partition, store } = request;
  const pending = store.pending(ownerAlias, partition);
  const existingStallIds = new Set(
    (store.state(ownerAlias, partition).outboxStalls ?? []).map(
      ({ operationId }) => operationId,
    ),
  );
  const stalled = pending.filter((encoded) =>
    existingStallIds.has(outboxIdentity(encoded)),
  );
  let remainsStalled = false;
  for (const envelope of stalled) {
    try {
      await request.transport.writeBatch(partition, [envelope], request.signal);
      store.acknowledge(ownerAlias, partition, [envelope]);
    } catch (error) {
      if (!isOperationSynchronizationBadRequest(error)) throw error;
      store.stallOutbox(ownerAlias, partition, envelope, error.message);
      remainsStalled = true;
    }
  }
  const pushable = pending.filter(
    (encoded) => !existingStallIds.has(outboxIdentity(encoded)),
  );
  if (pushable.length === 0) return remainsStalled;
  try {
    await request.transport.writeBatch(
      request.partition,
      pushable,
      request.signal,
    );
    request.store.acknowledge(ownerAlias, request.partition, pushable);
    return remainsStalled;
  } catch (error) {
    if (!isOperationSynchronizationBadRequest(error)) throw error;
    return (
      (await pushSinglyAfterBadRequest({ ...request, envelopes: pushable })) ||
      remainsStalled
    );
  }
};
const synchronizePartition = async (request: {
  readonly partition: OperationPartition;
  readonly signal: AbortSignal;
  readonly store: OperationStore;
  readonly transport: OperationTransport;
}): Promise<void> => {
  const { partition, signal, store, transport } = request;
  const outboxStalled = await pushOutbox(request);
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
  const outboxStalls = store.state(ownerAlias, partition).outboxStalls ?? [];
  if (outboxStalled || outboxStalls.length > 0) {
    const identities = outboxStalls.map(({ operationId }) => operationId).join(", ");
    throw new Error(
      `Operation synchronization outbox stalled: ${partition}${identities === "" ? "" : ` (${identities})`}`,
    );
  }
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
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
};
