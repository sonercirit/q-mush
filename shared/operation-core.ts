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

const sessionEntities = new Set([
  "agent_sessions",
  "agent_session_operations",
  "agent_session_turns",
  "agent_pending_inputs",
  "agent_question_requests",
  "agent_messages",
]);
const nonSessionEntities = new Set([
  "users",
  "workspaces",
  "prompts",
  "provider_credentials",
  "provider_quota_settings",
  "provider_quota_reset_receipts",
  "provider_credential_workspaces",
  "attachment_fallbacks",
  "runners",
  "runner_workspaces",
  "tool_settings",
]);
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

export interface OperationApplyState<TProjection> {
  readonly frontier: CausalFrontier;
  readonly pending: readonly Operation[];
  readonly projection: TProjection;
  readonly applied: Readonly<Record<string, string>>;
  readonly history?: readonly Operation[];
  readonly baseProjection?: TProjection;
  readonly baseFrontier?: CausalFrontier;
}
export const MAX_PENDING_OPERATIONS = 512;
const MAX_REPLAY_OPERATIONS = 512;
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
): Map<string, string> => {
  const index = new Map(Object.entries(state.applied));
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
): CausalFrontier =>
  operations.reduce(
    (frontier, item) => advanceFrontier(frontier, item.writerId, item.sequence),
    initial,
  );

export const applyOperation = <TProjection>(
  state: OperationApplyState<TProjection>,
  candidate: Operation,
  reducer: (projection: TProjection, operation: Operation) => TProjection,
): OperationApplyState<TProjection> => {
  validateValue(candidate);
  const fingerprint = canonical(candidate);
  const known = identityIndex(state);
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
  let history = [...(state.history ?? [])];
  let baseProjection = state.baseProjection ?? state.projection;
  let baseFrontier = { ...(state.baseFrontier ?? state.frontier) };
  const applied = { ...state.applied };
  let remaining = [...state.pending, candidate];

  if (
    isReady(candidate, frontier) &&
    frontierCovers(candidate.parents, frontier)
  ) {
    history = [];
    baseProjection = projection;
    baseFrontier = { ...frontier };
  }
  let ready = orderedReady(remaining, frontier);
  while (ready.length > 0) {
    const earliest = ready[0];
    if (earliest === undefined) break;
    if (history.some((item) => compareClocks(earliest.clock, item.clock) < 0)) {
      const replay = [...history, ...ready].sort((left, right) =>
        compareClocks(left.clock, right.clock),
      );
      if (replay.length > MAX_REPLAY_OPERATIONS)
        throw new Error("Operation replay history is full");
      projection = reduceOperations(baseProjection, replay, reducer);
      frontier = advanceOperations({ ...baseFrontier }, replay);
      history = replay;
    } else {
      projection = reduceOperations(projection, ready, reducer);
      frontier = advanceOperations(frontier, ready);
      history.push(...ready);
    }
    for (const item of ready) addApplied(applied, item);
    const readyIds = new Set(ready.map((item) => item.operationId));
    remaining = remaining.filter((item) => !readyIds.has(item.operationId));
    ready = orderedReady(remaining, frontier);
  }
  if (history.length > MAX_REPLAY_OPERATIONS)
    throw new Error("Operation replay history is full");
  return {
    frontier,
    pending: remaining,
    projection,
    applied,
    history,
    baseProjection,
    baseFrontier,
  };
};
