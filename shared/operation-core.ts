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
const addApplied = (
  root: AppliedNode | undefined,
  item: Operation,
): AppliedNode => {
  const fingerprint = canonical(item);
  let next = root;
  for (const key of identityKeys(item))
    next = setAppliedNode(next, key, fingerprint);
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

interface AppliedNode {
  readonly key: string;
  readonly value: string;
  readonly priority: number;
  readonly left: AppliedNode | undefined;
  readonly right: AppliedNode | undefined;
}
const appliedRoots = new WeakMap<object, AppliedNode | undefined>();
const appliedPriority = (key: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};
const rotateAppliedLeft = (node: AppliedNode): AppliedNode => {
  const right = node.right;
  if (right === undefined) return node;
  return {
    ...right,
    left: { ...node, right: right.left },
  };
};
const rotateAppliedRight = (node: AppliedNode): AppliedNode => {
  const left = node.left;
  if (left === undefined) return node;
  return {
    ...left,
    right: { ...node, left: left.right },
  };
};
const setAppliedNode = (
  node: AppliedNode | undefined,
  key: string,
  value: string,
): AppliedNode => {
  if (node === undefined)
    return {
      key,
      value,
      priority: appliedPriority(key),
      left: undefined,
      right: undefined,
    };
  if (key === node.key) return { ...node, value };
  if (compareText(key, node.key) < 0) {
    const next = { ...node, left: setAppliedNode(node.left, key, value) };
    return next.left.priority < next.priority ? rotateAppliedRight(next) : next;
  }
  const next = { ...node, right: setAppliedNode(node.right, key, value) };
  return next.right.priority < next.priority ? rotateAppliedLeft(next) : next;
};
const appliedRecord = (
  root: AppliedNode | undefined,
): Record<string, string> => {
  const record: Record<string, string> = {};
  const visit = (node: AppliedNode | undefined): void => {
    if (node === undefined) return;
    visit(node.left);
    record[node.key] = node.value;
    visit(node.right);
  };
  visit(root);
  appliedRoots.set(record, root);
  return record;
};
const writableApplied = (
  source: Readonly<Record<string, string>>,
): AppliedNode | undefined => {
  const known = appliedRoots.get(source);
  if (known !== undefined || appliedRoots.has(source)) return known;
  let root: AppliedNode | undefined;
  for (const [key, value] of Object.entries(source))
    root = setAppliedNode(root, key, value);
  return root;
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

  let frontier = state.frontier;
  let projection = state.projection;
  let replayHead = state.replayHead;
  let replayCount = state.replayCount;
  let replayLastClock = state.replayLastClock;
  const baseProjection = state.baseProjection;
  const baseFrontier = state.baseFrontier;
  let appliedRoot = writableApplied(state.applied);
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
  return {
    frontier,
    pending: remaining,
    projection,
    applied: appliedRecord(appliedRoot),
    replayHead,
    replayCount,
    replayLastClock,
    baseProjection,
    baseFrontier,
  };
};

type EncodedCheckpointValue = readonly [string, unknown];
const checkpointObject = (value: unknown): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Invalid checkpoint object");
  return value as Record<string, unknown>;
};
const exactCheckpointKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): void => {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid checkpoint fields");
};
const encodeCheckpointValue = (value: unknown): EncodedCheckpointValue => {
  validateValue(value);
  if (value === undefined) return ["undefined", null];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (Array.isArray(value)) return ["array", value.map(encodeCheckpointValue)];
  if (value !== null && typeof value === "object")
    return [
      "object",
      Object.entries(value).map(([key, item]) => [
        key,
        encodeCheckpointValue(item),
      ]),
    ];
  return ["primitive", value];
};
const decodeCheckpointValue = (value: unknown): unknown => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string"
  )
    throw new Error("Invalid encoded checkpoint value");
  const [tag, body] = value;
  if (tag === "undefined" && body === null) return undefined;
  if (
    tag === "bigint" &&
    typeof body === "string" &&
    /^-?(0|[1-9]\d*)$/.test(body)
  )
    return BigInt(body);
  if (tag === "date" && typeof body === "string") {
    const date = new Date(body);
    if (Number.isFinite(date.getTime()) && date.toISOString() === body)
      return date;
  }
  if (tag === "array" && Array.isArray(body))
    return body.map(decodeCheckpointValue);
  if (tag === "object" && Array.isArray(body)) {
    const result: Record<string, unknown> = {};
    for (const entry of body) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        Object.hasOwn(result, entry[0])
      )
        throw new Error("Invalid encoded checkpoint entry");
      result[entry[0]] = decodeCheckpointValue(entry[1]);
    }
    return result;
  }
  if (
    tag === "primitive" &&
    (body === null ||
      typeof body === "string" ||
      typeof body === "boolean" ||
      (typeof body === "number" && Number.isFinite(body)))
  )
    return body;
  throw new Error("Invalid encoded checkpoint tag");
};
const checkpointRecord = <T extends string | bigint>(
  value: unknown,
  kind: "string" | "bigint",
): Readonly<Record<string, T>> => {
  const record = checkpointObject(value);
  if (Object.values(record).some((item) => typeof item !== kind))
    throw new Error("Invalid checkpoint record");
  return record as Readonly<Record<string, T>>;
};
const decodeClock = (value: unknown): HybridTimestamp => {
  const clock = checkpointObject(value);
  exactCheckpointKeys(clock, ["physicalMs", "logical", "writerId"]);
  if (
    !Number.isFinite(clock["physicalMs"]) ||
    !Number.isSafeInteger(clock["logical"]) ||
    Number(clock["logical"]) < 0 ||
    typeof clock["writerId"] !== "string"
  )
    throw new Error("Invalid checkpoint clock");
  return {
    physicalMs: Number(clock["physicalMs"]),
    logical: Number(clock["logical"]),
    writerId: clock["writerId"],
  };
};
const decodeOperation = (value: unknown): Operation => {
  const item = checkpointObject(value);
  exactCheckpointKeys(item, [
    "operationId",
    "schemaVersion",
    "partition",
    "writerId",
    "sequence",
    "clock",
    "parents",
    "entity",
    "kind",
    "payload",
  ]);
  const entity = checkpointObject(item["entity"]);
  const entityKeys = Object.hasOwn(entity, "workspaceId")
    ? ["type", "id", "accountId", "workspaceId"]
    : ["type", "id", "accountId"];
  exactCheckpointKeys(entity, entityKeys);
  if (
    typeof item["operationId"] !== "string" ||
    typeof item["writerId"] !== "string" ||
    typeof item["sequence"] !== "bigint" ||
    typeof item["kind"] !== "string" ||
    typeof entity["type"] !== "string" ||
    typeof entity["id"] !== "string" ||
    typeof entity["accountId"] !== "string" ||
    (Object.hasOwn(entity, "workspaceId") &&
      typeof entity["workspaceId"] !== "string")
  )
    throw new Error("Invalid checkpoint operation");
  const operation = createOperation({
    operationId: item["operationId"],
    schemaVersion: Number(item["schemaVersion"]),
    writerId: item["writerId"],
    sequence: item["sequence"],
    clock: decodeClock(item["clock"]),
    parents: checkpointRecord<bigint>(item["parents"], "bigint"),
    entity: entity as unknown as OperationEntity,
    kind: item["kind"],
    payload: item["payload"],
  });
  if (item["partition"] !== operation.partition)
    throw new Error("Invalid checkpoint partition");
  return operation;
};
const decodeReplay = (value: unknown): ReplayEntry | undefined => {
  if (value === undefined) return undefined;
  const entry = checkpointObject(value);
  exactCheckpointKeys(entry, ["operation", "previous"]);
  return {
    operation: decodeOperation(entry["operation"]),
    previous: decodeReplay(entry["previous"]),
  };
};
export const encodeOperationCheckpoint = <TProjection>(
  state: OperationApplyState<TProjection>,
): string => JSON.stringify(encodeCheckpointValue(state));
export const decodeOperationCheckpoint = <TProjection>(
  encoded: string,
): OperationApplyState<TProjection> => {
  let decoded: unknown;
  try {
    decoded = decodeCheckpointValue(JSON.parse(encoded));
  } catch (error) {
    throw new Error("Invalid operation checkpoint", { cause: error });
  }
  const state = checkpointObject(decoded);
  exactCheckpointKeys(state, [
    "frontier",
    "pending",
    "projection",
    "applied",
    "replayHead",
    "replayCount",
    "replayLastClock",
    "baseProjection",
    "baseFrontier",
  ]);
  if (
    !Array.isArray(state["pending"]) ||
    !Number.isSafeInteger(state["replayCount"]) ||
    Number(state["replayCount"]) < 0
  )
    throw new Error("Invalid operation checkpoint");
  validateValue(state["projection"]);
  validateValue(state["baseProjection"]);
  return {
    frontier: checkpointRecord<bigint>(state["frontier"], "bigint"),
    pending: state["pending"].map(decodeOperation),
    projection: state["projection"] as TProjection,
    applied: checkpointRecord<string>(state["applied"], "string"),
    replayHead: decodeReplay(state["replayHead"]),
    replayCount: Number(state["replayCount"]),
    replayLastClock:
      state["replayLastClock"] === undefined
        ? undefined
        : decodeClock(state["replayLastClock"]),
    baseProjection: state["baseProjection"] as TProjection,
    baseFrontier: checkpointRecord<bigint>(state["baseFrontier"], "bigint"),
  };
};
