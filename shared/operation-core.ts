export type OperationPartition = "non-session" | "session";
export type CausalFrontier = Readonly<Record<string, bigint>>;

export interface HybridTimestamp {
  readonly physicalMs: number;
  readonly logical: number;
  readonly writerId: string;
}
interface OperationEntity {
  readonly type: string;
  readonly id: string;
  readonly accountId: string;
  readonly workspaceId?: string;
}
export interface Operation<TPayload = unknown> {
  readonly operationId: string;
  readonly schemaVersion: number;
  readonly partition: OperationPartition;
  readonly writerId: string;
  readonly sequence: bigint;
  readonly clock: HybridTimestamp;
  readonly parents: CausalFrontier;
  readonly entity: OperationEntity;
  readonly kind: string;
  readonly payload: TPayload;
}
type OperationInput<TPayload> = Omit<Operation<TPayload>, "partition">;
export type FrontierComparison =
  "equal" | "ancestor" | "descendant" | "concurrent";

export const operationEntityPartitions = {
  session: [
    ...["agent_sessions", "agent_session_operations"],
    ...["agent_session_turns", "agent_pending_inputs"],
    ...["agent_question_requests", "agent_messages"],
  ],
  "non-session":
    "users workspaces prompts provider_quota_settings provider_quota_reset_receipts provider_credential_workspaces attachment_fallbacks runner_workspaces tool_settings".split(
      " ",
    ),
} as const;
const sessionEntities: ReadonlySet<string> = new Set(
  operationEntityPartitions.session,
);
const nonSessionEntities: ReadonlySet<string> = new Set(
  operationEntityPartitions["non-session"],
);
export const classifyOperationPartition = (
  entityType: string,
): OperationPartition => {
  if (sessionEntities.has(entityType)) return "session";
  if (nonSessionEntities.has(entityType)) return "non-session";
  throw new Error(`Unknown operation entity: ${entityType}`);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const validateValue = (value: unknown, seen = new Set<object>()): void => {
  if (
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null
  )
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Operation numbers must be finite");
    return;
  }
  if (typeof value !== "object") throw new Error("Unsupported operation value");
  if (seen.has(value)) throw new Error("Operation values must not be cyclic");
  seen.add(value);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error("Operation dates must be valid");
  } else if (Array.isArray(value)) {
    for (const item of value) validateValue(item, seen);
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    )
      throw new Error("Operation objects must be plain and string-keyed");
    for (const item of Object.values(value)) validateValue(item, seen);
  }
  seen.delete(value);
};
export const createOperation = <TPayload>(
  input: OperationInput<TPayload>,
): Operation<TPayload> => {
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)
    throw new Error("schemaVersion must be positive");
  if (input.sequence < 1n) throw new Error("sequence must be positive");
  validateValue(input);
  return { ...input, partition: classifyOperationPartition(input.entity.type) };
};

export const compareClocks = (
  left: HybridTimestamp,
  right: HybridTimestamp,
): number =>
  left.physicalMs - right.physicalMs ||
  left.logical - right.logical ||
  compareText(left.writerId, right.writerId);
export const MAX_REMOTE_CLOCK_DRIFT_MS = 5 * 60 * 1000;
export interface HybridLogicalClock {
  readonly current: () => HybridTimestamp;
  readonly tick: (physicalMs: number) => HybridTimestamp;
  readonly receive: (
    remote: HybridTimestamp,
    physicalMs: number,
  ) => HybridTimestamp;
}
export const createHybridLogicalClock = (
  writerId: string,
  initialPhysicalMs = 0,
): HybridLogicalClock => {
  let physicalMs = initialPhysicalMs;
  let logical = 0;
  const current = (): HybridTimestamp => ({ physicalMs, logical, writerId });
  return {
    current,
    tick: (now) => {
      logical = now > physicalMs ? 0 : logical + 1;
      physicalMs = Math.max(physicalMs, now);
      return current();
    },
    receive: (remote, now) => {
      if (remote.physicalMs > now + MAX_REMOTE_CLOCK_DRIFT_MS)
        throw new Error("Remote clock is too far in the future");
      const nextPhysical = Math.max(physicalMs, remote.physicalMs, now);
      if (nextPhysical === physicalMs && nextPhysical === remote.physicalMs)
        logical = Math.max(logical, remote.logical) + 1;
      else if (nextPhysical === physicalMs) logical += 1;
      else if (nextPhysical === remote.physicalMs) logical = remote.logical + 1;
      else logical = 0;
      physicalMs = nextPhysical;
      return current();
    },
  };
};

const frontierValue = (frontier: CausalFrontier, writerId: string): bigint =>
  frontier[writerId] ?? 0n;
export const frontierCovers = (
  frontier: CausalFrontier,
  required: CausalFrontier,
): boolean =>
  Object.entries(required).every(
    ([writerId, sequence]) => frontierValue(frontier, writerId) >= sequence,
  );
export const mergeFrontiers = (
  left: CausalFrontier,
  right: CausalFrontier,
): CausalFrontier => {
  const merged: Record<string, bigint> = { ...left };
  for (const [writerId, sequence] of Object.entries(right)) {
    const previous = frontierValue(merged, writerId);
    merged[writerId] = sequence > previous ? sequence : previous;
  }
  return merged;
};
export const compareFrontiers = (
  left: CausalFrontier,
  right: CausalFrontier,
): FrontierComparison => {
  const leftCovers = frontierCovers(left, right);
  const rightCovers = frontierCovers(right, left);
  if (leftCovers && rightCovers) return "equal";
  if (leftCovers) return "descendant";
  if (rightCovers) return "ancestor";
  return "concurrent";
};
export const advanceFrontier = (
  frontier: CausalFrontier,
  writerId: string,
  sequence: bigint,
): CausalFrontier => {
  const previous = frontierValue(frontier, writerId);
  if (sequence !== previous + 1n)
    throw new Error(`Operation sequence gap for ${writerId}`);
  return { ...frontier, [writerId]: sequence };
};

interface ReplayEntry {
  readonly operation: Operation;
  readonly previous: ReplayEntry | undefined;
}
const appendReplay = (
  head: ReplayEntry | undefined,
  count: number,
  operations: readonly Operation[],
): { readonly head: ReplayEntry | undefined; readonly count: number } => {
  let nextHead = head;
  let nextCount = count;
  for (const operation of operations) {
    nextHead = { operation, previous: nextHead };
    nextCount += 1;
  }
  return { head: nextHead, count: nextCount };
};
export interface OperationApplyState<TProjection> {
  readonly frontier: CausalFrontier;
  readonly pending: readonly Operation[];
  readonly projection: TProjection;
  readonly applied: Readonly<Record<string, string>>;
  readonly replayHead: ReplayEntry | undefined;
  readonly replayCount: number;
  readonly replayLastClock: HybridTimestamp | undefined;
  readonly baseProjection: TProjection;
  readonly baseFrontier: CausalFrontier;
}
export const MAX_PENDING_OPERATIONS = 512;
export const compactOperationState = <TProjection>(
  state: OperationApplyState<TProjection>,
  stableFrontier: CausalFrontier,
): OperationApplyState<TProjection> => {
  if (compareFrontiers(state.frontier, stableFrontier) !== "equal")
    throw new Error("Compaction frontier must equal the applied frontier");
  if (state.pending.length > 0)
    throw new Error("Compaction requires an empty pending buffer");
  return {
    ...state,
    replayHead: undefined,
    replayCount: 0,
    replayLastClock: undefined,
    baseProjection: state.projection,
    baseFrontier: { ...state.frontier },
  };
};
const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const identityKeys = (candidate: Operation): readonly string[] => [
  `id:${candidate.operationId}`,
  `writer:${candidate.writerId}:${candidate.sequence.toString()}`,
];
const identityIndex = (
  state: OperationApplyState<unknown>,
  candidate: Operation,
): Map<string, string> => {
  const index = new Map<string, string>();
  for (const key of identityKeys(candidate)) {
    const fingerprint = state.applied[key];
    if (fingerprint !== undefined) index.set(key, fingerprint);
  }
  for (const item of state.pending) {
    const fingerprint = canonical(item);
    for (const key of identityKeys(item)) index.set(key, fingerprint);
  }
  return index;
};
const isReady = (item: Operation, frontier: CausalFrontier): boolean =>
  frontierCovers(frontier, item.parents) &&
  item.sequence === frontierValue(frontier, item.writerId) + 1n;
const addApplied = (applied: Record<string, string>, item: Operation): void => {
  const fingerprint = canonical(item);
  for (const key of identityKeys(item)) applied[key] = fingerprint;
};

const orderedReady = (
  operations: readonly Operation[],
  frontier: CausalFrontier,
): Operation[] =>
  operations
    .filter((item) => isReady(item, frontier))
    .sort((left, right) => compareClocks(left.clock, right.clock));
const reduceOperations = <TProjection>(
  initial: TProjection,
  operations: readonly Operation[],
  reducer: (projection: TProjection, operation: Operation) => TProjection,
): TProjection =>
  operations.reduce((projection, item) => reducer(projection, item), initial);

const advanceOperations = (
  initial: CausalFrontier,
  operations: readonly Operation[],
): CausalFrontier => {
  const advanced: Record<string, bigint> = { ...initial };
  for (const item of operations) {
    const previous = frontierValue(advanced, item.writerId);
    if (item.sequence > previous) advanced[item.writerId] = item.sequence;
  }
  return advanced;
};

const ownedApplied = new WeakSet<object>();
const writableApplied = (
  source: Readonly<Record<string, string>>,
): Record<string, string> => {
  if (ownedApplied.has(source)) return source;
  const copy = { ...source };
  ownedApplied.add(copy);
  return copy;
};

export const applyOperation = <TProjection>(
  state: OperationApplyState<TProjection>,
  candidate: Operation,
  reducer: (projection: TProjection, operation: Operation) => TProjection,
): OperationApplyState<TProjection> => {
  validateValue(candidate);
  const fingerprint = canonical(candidate);
  const known = identityIndex(state, candidate);
  for (const key of identityKeys(candidate)) {
    const existing = known.get(key);
    if (existing !== undefined && existing !== fingerprint)
      throw new Error(`Operation equivocation: ${key}`);
  }
  if (
    identityKeys(candidate).some((key) => state.applied[key] === fingerprint) ||
    state.pending.some((item) => item.operationId === candidate.operationId)
  )
    return state;
  if (
    state.pending.length >= MAX_PENDING_OPERATIONS &&
    !isReady(candidate, state.frontier)
  )
    throw new Error("Operation pending buffer is full");

  let frontier = { ...state.frontier };
  let projection = state.projection;
  let replayHead = state.replayHead;
  let replayCount = state.replayCount;
  let replayLastClock = state.replayLastClock;
  const baseProjection = state.baseProjection;
  const baseFrontier = { ...state.baseFrontier };
  const applied = writableApplied(state.applied);
  let remaining = [...state.pending, candidate];

  let ready = orderedReady(remaining, frontier);
  while (ready.length > 0) {
    const earliest = ready[0];
    if (earliest === undefined) break;
    if (
      replayLastClock !== undefined &&
      compareClocks(earliest.clock, replayLastClock) < 0
    ) {
      const history: Operation[] = [];
      for (let entry = replayHead; entry !== undefined; entry = entry.previous)
        history.push(entry.operation);
      history.reverse();
      const replay = [...history, ...ready].sort((left, right) =>
        compareClocks(left.clock, right.clock),
      );
      projection = reduceOperations(baseProjection, replay, reducer);
      frontier = advanceOperations({ ...baseFrontier }, replay);
      const appended = appendReplay(undefined, 0, replay);
      replayHead = appended.head;
      replayCount = appended.count;
      replayLastClock = replay.at(-1)?.clock;
    } else {
      projection = reduceOperations(projection, ready, reducer);
      frontier = advanceOperations(frontier, ready);
      const appended = appendReplay(replayHead, replayCount, ready);
      replayHead = appended.head;
      replayCount = appended.count;
      replayLastClock = ready.at(-1)?.clock;
    }
    for (const item of ready) {
      addApplied(applied, item);
      const itemFingerprint = canonical(item);
      void itemFingerprint;
    }
    const readyIds = new Set(ready.map((item) => item.operationId));
    remaining = remaining.filter((item) => !readyIds.has(item.operationId));
    ready = orderedReady(remaining, frontier);
  }
  return {
    frontier,
    pending: remaining,
    projection,
    applied,
    replayHead,
    replayCount,
    replayLastClock,
    baseProjection,
    baseFrontier,
  };
};
