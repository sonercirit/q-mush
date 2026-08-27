export interface OperationProtocolError extends Error {
  readonly operationError: "invalid" | "conflict";
}
export const operationProtocolError = (
  operationError: OperationProtocolError["operationError"],
  message: string,
): OperationProtocolError =>
  Object.assign(new Error(message), { operationError });
export const isOperationProtocolError = (
  value: unknown,
): value is OperationProtocolError =>
  value instanceof Error &&
  "operationError" in value &&
  (value.operationError === "invalid" || value.operationError === "conflict");

export type OperationPartition = "non-session" | "session";
export type CausalFrontier = Readonly<Record<string, bigint>>;

export interface HybridTimestamp {
  readonly physicalMs: number;
  readonly logical: number;
  readonly writerId: string;
}
export interface OperationEntity {
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
/** @public frontier relation type for replica ordering. */
export type FrontierComparison =
  "equal" | "ancestor" | "descendant" | "concurrent";

/** @public entity partition catalog for schema routing. */
export const operationEntityPartitions = {
  session: [
    "agent_sessions",
    "agent_session_operations",
    "agent_session_turns",
    "agent_pending_inputs",
    "agent_question_requests",
    "agent_messages",
  ],
  "non-session": [
    "users",
    "workspaces",
    "prompts",
    "provider_quota_settings",
    "provider_quota_reset_receipts",
    "provider_credential_workspaces",
    "attachment_fallbacks",
    "runner_workspaces",
    "tool_settings",
  ],
} as const;
const sessionEntities: ReadonlySet<string> = new Set(
  operationEntityPartitions.session,
);
const nonSessionEntities: ReadonlySet<string> = new Set(
  operationEntityPartitions["non-session"],
);
/** @public entity partition classifier for operation creation. */
export const classifyOperationPartition = (
  entityType: string,
): OperationPartition => {
  if (sessionEntities.has(entityType)) return "session";
  if (nonSessionEntities.has(entityType)) return "non-session";
  throw new Error(`Unknown operation entity: ${entityType}`);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const validateOperationValue = (
  value: unknown,
  seen = new Set<object>(),
): void => {
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
    for (const item of value) validateOperationValue(item, seen);
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    )
      throw new Error("Operation objects must be plain and string-keyed");
    for (const item of Object.values(value)) validateOperationValue(item, seen);
  }
  seen.delete(value);
};
export const createOperation = <TPayload>(
  input: OperationInput<TPayload>,
): Operation<TPayload> => {
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)
    throw new Error("schemaVersion must be positive");
  if (input.sequence < 1n) throw new Error("sequence must be positive");
  validateOperationValue(input);
  return { ...input, partition: classifyOperationPartition(input.entity.type) };
};

/** @public clock comparator for deterministic replay. */
export const compareClocks = (
  left: HybridTimestamp,
  right: HybridTimestamp,
): number =>
  left.physicalMs - right.physicalMs ||
  left.logical - right.logical ||
  compareText(left.writerId, right.writerId);
/** @public remote clock drift bound for authenticated intake. */
export const MAX_REMOTE_CLOCK_DRIFT_MS = 5 * 60 * 1000;
/** @public hybrid clock contract for replica writers. */
export interface HybridLogicalClock {
  readonly current: () => HybridTimestamp;
  readonly tick: (physicalMs: number) => HybridTimestamp;
  readonly receive: (
    remote: HybridTimestamp,
    physicalMs: number,
  ) => HybridTimestamp;
}
/** @public hybrid clock constructor for replica writers. */
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
/** @public causal coverage predicate for anti-entropy. */
export const frontierCovers = (
  frontier: CausalFrontier,
  required: CausalFrontier,
): boolean =>
  Object.entries(required).every(
    ([writerId, sequence]) => frontierValue(frontier, writerId) >= sequence,
  );
/** @public frontier merge primitive for replica reconciliation. */
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
/** @public frontier comparator for conflict detection. */
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
/** @public frontier advancement primitive for ordered writers. */
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

export interface ReplayEntry {
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
export interface AppliedIdentityNode {
  readonly key: string;
  readonly value: string;
  readonly priority: number;
  readonly left: AppliedIdentityNode | undefined;
  readonly right: AppliedIdentityNode | undefined;
}
export interface OperationApplyState<TProjection> {
  readonly frontier: CausalFrontier;
  readonly pending: readonly Operation[];
  readonly projection: TProjection;
  readonly applied: AppliedIdentityNode | undefined;
  readonly replayHead: ReplayEntry | undefined;
  readonly replayCount: number;
  readonly replayLastClock: HybridTimestamp | undefined;
  readonly baseProjection: TProjection;
  readonly baseFrontier: CausalFrontier;
}
/** @public batch admission bound shared with synchronization. */
export const MAX_OPERATION_BATCH_SIZE = 512;
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
export const operationFingerprint = canonical;
const identityKeys = (candidate: Operation): readonly string[] => [
  `id:${candidate.operationId}`,
  `writer:${candidate.writerId}:${candidate.sequence.toString()}`,
];
const findApplied = (
  root: AppliedIdentityNode | undefined,
  key: string,
): string | undefined => {
  let node = root;
  while (node !== undefined) {
    if (key === node.key) return node.value;
    node = compareText(key, node.key) < 0 ? node.left : node.right;
  }
  return undefined;
};
const pendingIdentityIndexes = new WeakMap<
  OperationApplyState<unknown>,
  AppliedIdentityNode | undefined
>();
const pendingIdentityIndex = (
  state: OperationApplyState<unknown>,
): AppliedIdentityNode | undefined => {
  if (pendingIdentityIndexes.has(state))
    return pendingIdentityIndexes.get(state);
  let index: AppliedIdentityNode | undefined;
  for (const item of state.pending) {
    index = addIdentityKeys(index, item);
  }
  pendingIdentityIndexes.set(state, index);
  return index;
};
const isReady = (item: Operation, frontier: CausalFrontier): boolean =>
  frontierCovers(frontier, item.parents) &&
  item.sequence === frontierValue(frontier, item.writerId) + 1n;
const addIdentityKeys = (
  root: AppliedIdentityNode | undefined,
  item: Operation,
  fingerprint = canonical(item),
): AppliedIdentityNode | undefined => {
  let next = root;
  for (const key of identityKeys(item))
    next = setAppliedNode(next, key, fingerprint);
  return next;
};
const addApplied = (
  root: AppliedIdentityNode | undefined,
  item: Operation,
): AppliedIdentityNode => {
  const next = addIdentityKeys(root, item);
  if (next === undefined) throw new Error("Applied identity update failed");
  return next;
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

const appliedPriority = (key: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};
const rotateAppliedLeft = (node: AppliedIdentityNode): AppliedIdentityNode => {
  const right = node.right;
  if (right === undefined) return node;
  return {
    ...right,
    left: { ...node, right: right.left },
  };
};
const rotateAppliedRight = (node: AppliedIdentityNode): AppliedIdentityNode => {
  const left = node.left;
  if (left === undefined) return node;
  return {
    ...left,
    right: { ...node, left: left.right },
  };
};
const setAppliedNode = (
  node: AppliedIdentityNode | undefined,
  key: string,
  value: string,
): AppliedIdentityNode => {
  if (node === undefined)
    return {
      key,
      value,
      priority: appliedPriority(key),
      left: undefined,
      right: undefined,
    };
  if (compareText(key, node.key) < 0) {
    const next = { ...node, left: setAppliedNode(node.left, key, value) };
    return next.left.priority < next.priority ? rotateAppliedRight(next) : next;
  }
  const next = { ...node, right: setAppliedNode(node.right, key, value) };
  return next.right.priority < next.priority ? rotateAppliedLeft(next) : next;
};
export const materializeApplied = (
  root: AppliedIdentityNode | undefined,
): Readonly<Record<string, string>> => {
  const record: Record<string, string> = {};
  const visit = (node: AppliedIdentityNode | undefined): void => {
    if (node === undefined) return;
    if (
      (node.left !== undefined && node.left.priority < node.priority) ||
      (node.right !== undefined && node.right.priority < node.priority)
    )
      throw new Error("Applied identity index invariant failed");
    visit(node.left);
    record[node.key] = node.value;
    visit(node.right);
  };
  visit(root);
  return record;
};
/** @public identity tree depth diagnostic for balance tests. */
export const appliedIdentityDepth = (
  root: AppliedIdentityNode | undefined,
): number =>
  root === undefined
    ? 0
    : 1 +
      Math.max(
        appliedIdentityDepth(root.left),
        appliedIdentityDepth(root.right),
      );
const appliedFromRecord = (
  source: Readonly<Record<string, string>>,
): AppliedIdentityNode | undefined => {
  let root: AppliedIdentityNode | undefined;
  for (const [key, value] of Object.entries(source))
    root = setAppliedNode(root, key, value);
  return root;
};
export const restoreAppliedIdentityIndex = appliedFromRecord;

export const applyOperation = <TProjection>(
  state: OperationApplyState<TProjection>,
  candidate: Operation,
  reducer: (projection: TProjection, operation: Operation) => TProjection,
): OperationApplyState<TProjection> => {
  validateOperationValue(candidate);
  const fingerprint = canonical(candidate);
  const pendingIndex = pendingIdentityIndex(state);
  for (const key of identityKeys(candidate)) {
    const existing =
      findApplied(state.applied, key) ?? findApplied(pendingIndex, key);
    if (existing !== undefined && existing !== fingerprint)
      throw operationProtocolError(
        "conflict",
        `Operation equivocation: ${key}`,
      );
  }
  if (
    identityKeys(candidate).some(
      (key) => findApplied(state.applied, key) === fingerprint,
    ) ||
    state.pending.some((item) => item.operationId === candidate.operationId)
  )
    return state;
  if (
    state.pending.length >= MAX_OPERATION_BATCH_SIZE &&
    !isReady(candidate, state.frontier)
  )
    throw operationProtocolError("invalid", "Operation pending buffer is full");

  if (!isReady(candidate, state.frontier)) {
    const nextPendingIndex = addIdentityKeys(
      pendingIndex,
      candidate,
      fingerprint,
    );
    const buffered: OperationApplyState<TProjection> = {
      ...state,
      pending: [...state.pending, candidate],
    };
    pendingIdentityIndexes.set(buffered, nextPendingIndex);
    return buffered;
  }

  let frontier = state.frontier;
  let projection = state.projection;
  let replayHead = state.replayHead;
  let replayCount = state.replayCount;
  let replayLastClock = state.replayLastClock;
  const baseProjection = state.baseProjection;
  const baseFrontier = state.baseFrontier;
  let appliedRoot = state.applied;
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
      frontier = advanceOperations(baseFrontier, replay);
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
    for (const item of ready) appliedRoot = addApplied(appliedRoot, item);
    const readyIds = new Set(ready.map((item) => item.operationId));
    remaining = remaining.filter((item) => !readyIds.has(item.operationId));
    ready = orderedReady(remaining, frontier);
  }
  const nextPendingIndex = addIdentityKeys(
    pendingIndex,
    candidate,
    fingerprint,
  );
  const nextState: OperationApplyState<TProjection> = {
    frontier,
    pending: remaining,
    projection,
    applied: appliedRoot,
    replayHead,
    replayCount,
    replayLastClock,
    baseProjection,
    baseFrontier,
  };
  pendingIdentityIndexes.set(nextState, nextPendingIndex);
  return nextState;
};
