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
]);

export const classifyOperationPartition = (
  entityType: string,
): OperationPartition => {
  if (sessionEntities.has(entityType)) return "session";
  if (nonSessionEntities.has(entityType)) return "non-session";
  throw new Error(`Unknown operation entity: ${entityType}`);
};

export const createOperation = <TPayload>(
  input: OperationInput<TPayload>,
): Operation<TPayload> => {
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)
    throw new Error("schemaVersion must be positive");
  if (input.sequence < 1n) throw new Error("sequence must be positive");
  return { ...input, partition: classifyOperationPartition(input.entity.type) };
};

export const compareClocks = (
  left: HybridTimestamp,
  right: HybridTimestamp,
): number =>
  left.physicalMs - right.physicalMs ||
  left.logical - right.logical ||
  left.writerId.localeCompare(right.writerId);

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
      const nextPhysical = Math.max(physicalMs, remote.physicalMs, now);
      logical =
        nextPhysical === physicalMs && nextPhysical === remote.physicalMs
          ? Math.max(logical, remote.logical) + 1
          : nextPhysical === physicalMs
            ? logical + 1
            : nextPhysical === remote.physicalMs
              ? remote.logical + 1
              : 0;
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
  for (const [writerId, sequence] of Object.entries(right))
    merged[writerId] =
      sequence > frontierValue(merged, writerId)
        ? sequence
        : frontierValue(merged, writerId);
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
}

const canonical = (value: unknown): string => {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const identityKeys = (candidate: Operation): readonly string[] => [
  `id:${candidate.operationId}`,
  `writer:${candidate.writerId}:${candidate.sequence.toString()}`,
];

const assertNoEquivocation = (
  state: OperationApplyState<unknown>,
  candidate: Operation,
): string => {
  const fingerprint = canonical(candidate);
  const known = [...state.pending, candidate].flatMap((item) =>
    identityKeys(item).map((key) => [key, canonical(item)] as const),
  );
  for (const key of identityKeys(candidate)) {
    const appliedFingerprint = state.applied[key];
    const pendingFingerprint = known.find(
      ([pendingKey]) => pendingKey === key,
    )?.[1];
    if (
      (appliedFingerprint !== undefined &&
        appliedFingerprint !== fingerprint) ||
      (pendingFingerprint !== undefined && pendingFingerprint !== fingerprint)
    )
      throw new Error(`Operation equivocation: ${key}`);
  }
  return fingerprint;
};

export const applyOperation = <TProjection>(
  state: OperationApplyState<TProjection>,
  candidate: Operation,
  reducer: (projection: TProjection, operation: Operation) => TProjection,
): OperationApplyState<TProjection> => {
  const fingerprint = assertNoEquivocation(state, candidate);
  if (
    state.applied[`id:${candidate.operationId}`] === fingerprint ||
    state.pending.some((item) => item.operationId === candidate.operationId)
  )
    return state;
  const queued = [...state.pending, candidate];
  let frontier = state.frontier;
  let projection = state.projection;
  const applied = { ...state.applied };
  let remaining = queued;
  let progressed = true;
  while (progressed) {
    progressed = false;
    const next: Operation[] = [];
    for (const item of remaining) {
      if (
        frontierCovers(frontier, item.parents) &&
        item.sequence === frontierValue(frontier, item.writerId) + 1n
      ) {
        projection = reducer(projection, item);
        frontier = advanceFrontier(frontier, item.writerId, item.sequence);
        const itemFingerprint = canonical(item);
        for (const key of identityKeys(item)) applied[key] = itemFingerprint;
        progressed = true;
      } else next.push(item);
    }
    remaining = next;
  }
  return { frontier, pending: remaining, projection, applied };
};
