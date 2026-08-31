import { decodeHybridTimestamp } from "./operation-clock-codec";
import {
  compareClocks,
  createOperation,
  materializeApplied,
  operationFingerprint,
  operationIdentityKeys,
  restoreAppliedIdentityIndex,
  validateOperationWriterClocks,
  type HybridTimestamp,
  type Operation,
  type OperationApplyState,
  type OperationEntity,
  type ReplayEntry,
} from "./operation-core";
import { freezeOperationValue } from "./operation-value";

type EncodedCheckpointValue = readonly [string, unknown];
const isCheckpointObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const checkpointObject = (value: unknown): Record<string, unknown> => {
  if (!isCheckpointObject(value)) throw new Error("Invalid checkpoint object");
  return value;
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
  const root: { value?: EncodedCheckpointValue } = {};
  const pending: {
    readonly value: unknown;
    readonly assign: (encoded: EncodedCheckpointValue) => void;
  }[] = [{ value, assign: (encoded) => (root.value = encoded) }];
  while (pending.length > 0) {
    const task = pending.pop();
    if (task === undefined) break;
    const item = task.value;
    if (item === undefined) task.assign(["undefined", null]);
    else if (typeof item === "bigint") task.assign(["bigint", item.toString()]);
    else if (item instanceof Date) task.assign(["date", item.toISOString()]);
    else if (Array.isArray(item)) {
      const body: EncodedCheckpointValue[] = [];
      task.assign(["array", body]);
      for (let index = item.length - 1; index >= 0; index -= 1)
        pending.push({
          value: item[index],
          assign: (encoded) => (body[index] = encoded),
        });
    } else if (isCheckpointObject(item)) {
      const body: [string, EncodedCheckpointValue][] = [];
      task.assign(["object", body]);
      const entries = Object.entries(item);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry !== undefined)
          pending.push({
            value: entry[1],
            assign: (encoded) => (body[index] = [entry[0], encoded]),
          });
      }
    } else task.assign(["primitive", item]);
  }
  if (root.value === undefined) throw new Error("Checkpoint encoding failed");
  return root.value;
};
const isEncodedPair = (value: unknown): value is [string, unknown] =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
const decodeCheckpointValue = (value: unknown): unknown => {
  if (!isEncodedPair(value))
    throw new Error("Invalid encoded checkpoint value");
  const tag = value[0];
  const body = value[1];
  if (tag === "undefined" && body === null) return undefined;
  if (
    tag === "bigint" &&
    typeof body === "string" &&
    /^(0|-?[1-9]\d*)$/.test(body)
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
        typeof entry[0] !== "string"
      )
        throw new Error("Invalid encoded checkpoint entry");
      const key = entry[0];
      if (Object.hasOwn(result, key))
        throw new Error("Invalid encoded checkpoint entry");
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: decodeCheckpointValue(entry[1]),
        writable: true,
      });
    }
    return result;
  }
  if (
    tag === "primitive" &&
    (body === null ||
      typeof body === "string" ||
      typeof body === "boolean" ||
      (typeof body === "number" &&
        Number.isFinite(body) &&
        !Object.is(body, -0)))
  )
    return body;
  throw new Error("Invalid encoded checkpoint tag");
};
const typedCheckpointRecord = <T extends string | bigint>(
  value: unknown,
  valid: (item: unknown) => item is T,
): Readonly<Record<string, T>> => {
  const entries: [string, T][] = [];
  for (const [key, item] of Object.entries(checkpointObject(value))) {
    if (!valid(item)) throw new Error("Invalid checkpoint record");
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
};
const stringCheckpointRecord = (
  value: unknown,
): Readonly<Record<string, string>> =>
  typedCheckpointRecord(
    value,
    (item): item is string => typeof item === "string",
  );
const nonNegativeBigintCheckpointRecord = (
  value: unknown,
): Readonly<Record<string, bigint>> =>
  typedCheckpointRecord(
    value,
    (item): item is bigint => typeof item === "bigint" && item >= 0n,
  );
const decodeClock = (value: unknown): HybridTimestamp =>
  decodeHybridTimestamp(value, () => new Error("Invalid checkpoint clock"));
const decodeOperation = (
  value: unknown,
  deferOwnWriterParentValidation = false,
): Operation => {
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
  const workspaceId = entity["workspaceId"];
  if (
    typeof item["operationId"] !== "string" ||
    typeof item["schemaVersion"] !== "number" ||
    !Number.isSafeInteger(item["schemaVersion"]) ||
    typeof item["writerId"] !== "string" ||
    typeof item["sequence"] !== "bigint" ||
    typeof item["kind"] !== "string" ||
    typeof entity["type"] !== "string" ||
    typeof entity["id"] !== "string" ||
    typeof entity["accountId"] !== "string" ||
    (Object.hasOwn(entity, "workspaceId") && typeof workspaceId !== "string")
  )
    throw new Error("Invalid checkpoint operation");
  const decodedEntity: OperationEntity = {
    type: entity["type"],
    id: entity["id"],
    accountId: entity["accountId"],
    ...(typeof workspaceId === "string" ? { workspaceId } : {}),
  };
  const parents = nonNegativeBigintCheckpointRecord(item["parents"]);
  const ownParent = Object.hasOwn(parents, item["writerId"])
    ? parents[item["writerId"]]
    : undefined;
  const operation = createOperation({
    operationId: item["operationId"],
    schemaVersion: item["schemaVersion"],
    writerId: item["writerId"],
    sequence: item["sequence"],
    clock: decodeClock(item["clock"]),
    parents:
      deferOwnWriterParentValidation &&
      ownParent !== undefined &&
      ownParent >= item["sequence"]
        ? Object.fromEntries(
            Object.entries(parents).filter(
              ([writerId]) => writerId !== item["writerId"],
            ),
          )
        : parents,
    entity: decodedEntity,
    kind: item["kind"],
    payload: item["payload"],
  });
  const decodedOperation = deferOwnWriterParentValidation
    ? { ...operation, parents }
    : operation;
  if (item["partition"] !== decodedOperation.partition)
    throw new Error("Invalid checkpoint partition");
  return freezeOperationValue(decodedOperation);
};
const decodeReplay = (value: unknown): ReplayEntry | undefined => {
  if (!Array.isArray(value)) throw new Error("Invalid checkpoint replay");
  let replay: ReplayEntry | undefined;
  for (let index = value.length - 1; index >= 0; index -= 1)
    replay = {
      operation: decodeOperation(value[index], true),
      previous: replay,
    };
  return replay;
};
const decodeEncoded = (encoded: string, label: string): unknown => {
  try {
    return decodeCheckpointValue(JSON.parse(encoded));
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error });
  }
};
export const encodeOperationEnvelope = (operation: Operation): string =>
  JSON.stringify(encodeCheckpointValue(operation));
export const decodeOperationEnvelope = (encoded: string): Operation =>
  decodeOperation(decodeEncoded(encoded, "operation envelope"));

export interface OperationProjectionCodec<TProjection> {
  readonly encode: (projection: TProjection) => unknown;
  readonly decode: (value: unknown) => TProjection;
}

const replayOperations = (head: ReplayEntry | undefined): Operation[] => {
  const replay: Operation[] = [];
  for (let entry = head; entry !== undefined; entry = entry.previous)
    replay.push(entry.operation);
  return replay;
};
const legacyStringProjectionCodec: OperationProjectionCodec<unknown> = {
  encode: (projection) => {
    if (
      !Array.isArray(projection) ||
      !projection.every((item) => typeof item === "string")
    )
      throw new Error("Invalid legacy string projection");
    return projection;
  },
  decode: (value) => {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    )
      throw new Error("Invalid legacy string projection");
    return value;
  },
};

export function encodeOperationCheckpoint(
  state: OperationApplyState<readonly string[]>,
): string;
export function encodeOperationCheckpoint<TProjection>(
  state: OperationApplyState<TProjection>,
  codec: OperationProjectionCodec<TProjection>,
): string;
export function encodeOperationCheckpoint(
  state: OperationApplyState<unknown>,
  codec: OperationProjectionCodec<unknown> = legacyStringProjectionCodec,
): string {
  const replay = replayOperations(state.replayHead);
  return JSON.stringify(
    encodeCheckpointValue({
      ...state,
      projection: codec.encode(state.projection),
      baseProjection: codec.encode(state.baseProjection),
      applied: materializeApplied(state.applied),
      replayHead: replay,
    }),
  );
}
const clocksEqual = (
  left: HybridTimestamp | undefined,
  right: HybridTimestamp | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : left.physicalMs === right?.physicalMs &&
      left.logical === right.logical &&
      left.writerId === right.writerId;
const nullPrototypeBigintRecord = (): Record<string, bigint> => {
  const record: Record<string, bigint> = {};
  Object.setPrototypeOf(record, null);
  return record;
};
const validateCheckpointConsistency = <TProjection>(
  state: OperationApplyState<TProjection>,
): void => {
  const replay = replayOperations(state.replayHead);
  if (
    (state.stableClock === undefined) !==
    (Object.keys(state.baseFrontier).length === 0)
  )
    throw new Error("Invalid operation checkpoint stable frontier");
  if (
    state.stableClock !== undefined &&
    !Object.hasOwn(state.baseFrontier, state.stableClock.writerId)
  )
    throw new Error("Invalid operation checkpoint stable writer");
  const stableClock = state.stableClock;
  if (
    stableClock !== undefined &&
    [...replay, ...state.pending].some(
      (operation) => compareClocks(operation.clock, stableClock) <= 0,
    )
  )
    throw new Error("Invalid operation checkpoint stable clock order");
  for (let index = 1; index < replay.length; index += 1) {
    const newer = replay[index - 1];
    const older = replay[index];
    if (
      newer !== undefined &&
      older !== undefined &&
      compareClocks(newer.clock, older.clock) < 0
    )
      throw new Error("Invalid operation checkpoint replay clock order");
  }
  if (
    replay.length !== state.replayCount ||
    !clocksEqual(state.replayLastClock, state.replayHead?.operation.clock)
  )
    throw new Error("Invalid operation checkpoint replay metadata");
  const expectedFrontier = Object.assign(
    nullPrototypeBigintRecord(),
    state.baseFrontier,
  );
  const expectedApplied: Record<string, string> = {};
  const replayIdentities = new Set<string>();
  for (const operation of replay) {
    const replayFingerprint = operationFingerprint(operation);
    for (const identity of operationIdentityKeys(operation)) {
      if (replayIdentities.has(identity))
        throw new Error("Invalid operation checkpoint replay identity");
      replayIdentities.add(identity);
      expectedApplied[identity] = replayFingerprint;
    }
  }
  for (let index = replay.length - 1; index >= 0; index -= 1) {
    const operation = replay[index];
    if (operation === undefined) continue;
    const previous = Object.hasOwn(expectedFrontier, operation.writerId)
      ? (expectedFrontier[operation.writerId] ?? 0n)
      : 0n;
    if (operation.sequence !== previous + 1n)
      throw new Error("Invalid operation checkpoint replay sequence");
    Object.defineProperty(expectedFrontier, operation.writerId, {
      configurable: true,
      enumerable: true,
      value: operation.sequence,
      writable: true,
    });
  }
  for (const operation of replay) {
    for (const [writerId, sequence] of Object.entries(operation.parents)) {
      const covered = Object.hasOwn(expectedFrontier, writerId)
        ? (expectedFrontier[writerId] ?? 0n)
        : 0n;
      if (
        sequence > covered ||
        (writerId === operation.writerId && sequence >= operation.sequence)
      )
        throw new Error("Invalid operation checkpoint replay parent");
    }
  }
  validateOperationWriterClocks([...replay, ...state.pending]);
  const actualApplied = materializeApplied(state.applied);
  const pendingIdentities: Record<string, string> = {};
  if (
    operationFingerprint(expectedFrontier) !==
      operationFingerprint(state.frontier) ||
    operationFingerprint(expectedApplied) !==
      operationFingerprint(actualApplied)
  )
    throw new Error("Invalid operation checkpoint derived state");
  for (const operation of state.pending) {
    if (
      Object.hasOwn(operation.parents, operation.writerId) &&
      (operation.parents[operation.writerId] ?? 0n) >= operation.sequence
    )
      throw new Error("Invalid operation checkpoint pending parent");
    const fingerprint = operationFingerprint(operation);
    const identities = operationIdentityKeys(operation);
    if (
      identities.some((identity) => {
        const appliedFingerprint = actualApplied[identity];
        const pendingFingerprint = pendingIdentities[identity];
        if (
          appliedFingerprint !== undefined ||
          pendingFingerprint !== undefined
        )
          return true;
        pendingIdentities[identity] = fingerprint;
        return false;
      })
    )
      throw new Error("Invalid operation checkpoint pending identity");
  }
};
export function decodeOperationCheckpoint(
  encoded: string,
): OperationApplyState<readonly string[]>;
export function decodeOperationCheckpoint<TProjection>(
  encoded: string,
  codec: OperationProjectionCodec<TProjection>,
): OperationApplyState<TProjection>;
export function decodeOperationCheckpoint(
  encoded: string,
  codec: OperationProjectionCodec<unknown> = legacyStringProjectionCodec,
): OperationApplyState<unknown> {
  const decoded = decodeEncoded(encoded, "operation checkpoint");
  const state = checkpointObject(decoded);
  const checkpointKeys = [
    "frontier",
    "pending",
    "projection",
    "applied",
    "replayHead",
    "replayCount",
    "replayLastClock",
    "baseProjection",
    "baseFrontier",
  ] as const;
  const actualKeys = Object.keys(state);
  const legacy = actualKeys.length === checkpointKeys.length;
  exactCheckpointKeys(
    state,
    legacy ? checkpointKeys : [...checkpointKeys, "stableClock"],
  );
  if (
    !Array.isArray(state["pending"]) ||
    !Number.isSafeInteger(state["replayCount"]) ||
    Number(state["replayCount"]) < 0
  )
    throw new Error("Invalid operation checkpoint");
  let projection: unknown;
  let baseProjection: unknown;
  try {
    projection = codec.decode(state["projection"]);
  } catch (error) {
    throw new Error("Invalid operation checkpoint projection", {
      cause: error,
    });
  }
  try {
    baseProjection = codec.decode(state["baseProjection"]);
  } catch (error) {
    throw new Error("Invalid operation checkpoint base projection", {
      cause: error,
    });
  }
  const result: OperationApplyState<unknown> = {
    frontier: nonNegativeBigintCheckpointRecord(state["frontier"]),
    pending: state["pending"].map((operation) =>
      decodeOperation(operation, true),
    ),
    projection,
    applied: restoreAppliedIdentityIndex(
      stringCheckpointRecord(state["applied"]),
    ),
    replayHead: decodeReplay(state["replayHead"]),
    replayCount: Number(state["replayCount"]),
    replayLastClock:
      state["replayLastClock"] === undefined
        ? undefined
        : decodeClock(state["replayLastClock"]),
    baseProjection,
    baseFrontier: nonNegativeBigintCheckpointRecord(state["baseFrontier"]),
    stableClock:
      legacy || state["stableClock"] === undefined
        ? undefined
        : decodeClock(state["stableClock"]),
  };
  validateCheckpointConsistency(result);
  return result;
}
