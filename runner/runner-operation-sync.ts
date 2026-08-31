import { decodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type {
  CausalFrontier,
  HybridTimestamp,
  OperationPartition,
} from "../shared/operation-core.ts";
import type { OperationStabilityBoundary } from "../shared/operation-stability.ts";
import { isOperationSynchronizationBadRequest } from "./runner-operation-transport.ts";

interface OutboxStall {
  readonly operationId: string;
  readonly queuedBehind: number;
  readonly reason: string;
  readonly writerId: string;
}
interface OperationStore {
  readonly acknowledge: (
    ownerId: string,
    partition: OperationPartition,
    envelopes: readonly string[],
  ) => void;
  readonly compact?: (
    ownerId: string,
    partition: OperationPartition,
    stableClock: HybridTimestamp | null,
    stableFrontier: CausalFrontier | null,
  ) => void;
  readonly apply: (
    ownerId: string,
    partition: OperationPartition,
    envelopes: readonly string[],
    source: "remote",
    stability?: OperationStabilityBoundary,
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
    readonly stableClock?: HybridTimestamp | null;
    readonly stableFrontier?: CausalFrontier | null;
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
interface OutboxIdentity {
  readonly operationId: string;
  readonly writerId: string;
}
const outboxIdentity = (encoded: string): OutboxIdentity => {
  try {
    const operation = decodeOperationEnvelope(encoded);
    return {
      operationId: operation.operationId,
      writerId: operation.writerId,
    };
  } catch {
    return { operationId: encoded, writerId: "unknown-writer" };
  }
};
interface PartitionRequest {
  readonly partition: OperationPartition;
  readonly signal: AbortSignal;
  readonly store: OperationStore;
  readonly transport: OperationTransport;
}
const acceptedPush = async (
  request: PartitionRequest,
  envelopes: readonly string[],
): Promise<void> => {
  await request.transport.writeBatch(
    request.partition,
    envelopes,
    request.signal,
  );
  request.store.acknowledge(ownerAlias, request.partition, envelopes);
};
const pushOne = async (
  request: PartitionRequest,
  envelope: string,
): Promise<boolean> => {
  try {
    await acceptedPush(request, [envelope]);
    return false;
  } catch (error) {
    if (!isOperationSynchronizationBadRequest(error)) throw error;
    request.store.stallOutbox(
      ownerAlias,
      request.partition,
      envelope,
      error.message,
    );
    return true;
  }
};
const pushSinglyAfterBadRequest = async (
  request: PartitionRequest & { readonly envelopes: readonly string[] },
): Promise<boolean> => {
  const blockedWriters = new Set<string>();
  let stalled = false;
  for (const envelope of request.envelopes) {
    const { writerId } = outboxIdentity(envelope);
    if (blockedWriters.has(writerId)) continue;
    const rejected = await pushOne(request, envelope);
    if (rejected) blockedWriters.add(writerId);
    stalled = rejected || stalled;
  }
  return stalled;
};
const pushOutbox = async (request: PartitionRequest): Promise<boolean> => {
  const { partition, store } = request;
  const pending = store.pending(ownerAlias, partition);
  const existingStalls = store.state(ownerAlias, partition).outboxStalls ?? [];
  const stalledByWriter = new Map(
    existingStalls.map((stall) => [stall.writerId, stall.operationId]),
  );
  const stalledHeads = pending.filter((encoded) => {
    const identity = outboxIdentity(encoded);
    return stalledByWriter.get(identity.writerId) === identity.operationId;
  });
  let remainsStalled = false;
  const retriedHeadIds = new Set<string>();
  for (const envelope of stalledHeads) {
    retriedHeadIds.add(outboxIdentity(envelope).operationId);
    remainsStalled = (await pushOne(request, envelope)) || remainsStalled;
  }
  const stillBlockedWriters = new Set(
    (store.state(ownerAlias, partition).outboxStalls ?? []).map(
      (stall) => stall.writerId,
    ),
  );
  const pushable = pending.filter((encoded) => {
    const identity = outboxIdentity(encoded);
    return (
      !retriedHeadIds.has(identity.operationId) &&
      !stillBlockedWriters.has(identity.writerId)
    );
  });
  if (pushable.length === 0) return remainsStalled;
  try {
    await acceptedPush(request, pushable);
    return remainsStalled;
  } catch (error) {
    if (!isOperationSynchronizationBadRequest(error)) throw error;
    return (
      (await pushSinglyAfterBadRequest({ ...request, envelopes: pushable })) ||
      remainsStalled
    );
  }
};
const MAX_REPORTED_STALL_IDENTITIES = 5;
const MAX_REPORTED_STALL_IDENTITY_CHARACTERS = 64;
const describeStallIdentity = (identity: string): string =>
  identity.length <= MAX_REPORTED_STALL_IDENTITY_CHARACTERS
    ? identity
    : `${identity.slice(0, MAX_REPORTED_STALL_IDENTITY_CHARACTERS)}…`;
const describeOutboxStalls = (outboxStalls: readonly OutboxStall[]): string => {
  const shown = outboxStalls
    .slice(0, MAX_REPORTED_STALL_IDENTITIES)
    .map(({ operationId }) => describeStallIdentity(operationId))
    .join(", ");
  const omitted = outboxStalls.length - MAX_REPORTED_STALL_IDENTITIES;
  const identities = omitted > 0 ? `${shown}, +${String(omitted)} more` : shown;
  const queuedBehind = outboxStalls.reduce(
    (total, stall) => total + stall.queuedBehind,
    0,
  );
  return ` (${identities}; ${String(queuedBehind)} queued behind; ${String(outboxStalls.length)} stalled)`;
};
const synchronizePartition = async (
  request: PartitionRequest,
): Promise<void> => {
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
      store.apply(ownerAlias, partition, page.envelopes, "remote", {
        stableClock: page.stableClock ?? null,
        stableFrontier: page.stableFrontier ?? null,
      });
      if (store.state(ownerAlias, partition).stalled)
        throw new Error(
          `Operation synchronization partition stalled: ${partition}`,
        );
    }
    store.compact?.(
      ownerAlias,
      partition,
      page.stableClock ?? null,
      page.stableFrontier ?? null,
    );
    hasMore = page.hasMore;
  } while (hasMore);
  const outboxStalls = store.state(ownerAlias, partition).outboxStalls ?? [];
  if (outboxStalled || outboxStalls.length > 0) {
    throw new Error(
      `Operation synchronization outbox stalled: ${partition}${outboxStalls.length === 0 ? "" : describeOutboxStalls(outboxStalls)}`,
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
