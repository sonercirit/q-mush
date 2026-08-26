import {
  createOperation,
  materializeApplied,
  restoreAppliedIdentityIndex,
  type HybridTimestamp,
  type Operation,
  type OperationApplyState,
  type OperationEntity,
  type ReplayEntry,
} from "./operation-core";

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
  if (value === undefined) return ["undefined", null];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (Array.isArray(value)) {
    const encoded = value.map(encodeCheckpointValue);
    return ["array", encoded];
  }
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
const bigintCheckpointRecord = (
  value: unknown,
): Readonly<Record<string, bigint>> =>
  typedCheckpointRecord(
    value,
    (item): item is bigint => typeof item === "bigint",
  );
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
  const operation = createOperation({
    operationId: item["operationId"],
    schemaVersion: item["schemaVersion"],
    writerId: item["writerId"],
    sequence: item["sequence"],
    clock: decodeClock(item["clock"]),
    parents: bigintCheckpointRecord(item["parents"]),
    entity: decodedEntity,
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

export type OperationCheckpointProjection = readonly string[];

export const encodeOperationCheckpoint = (
  state: OperationApplyState<OperationCheckpointProjection>,
): string =>
  JSON.stringify(
    encodeCheckpointValue({
      ...state,
      applied: materializeApplied(state.applied),
    }),
  );
export const decodeOperationCheckpoint = (
  encoded: string,
): OperationApplyState<OperationCheckpointProjection> => {
  const decoded = decodeEncoded(encoded, "operation checkpoint");
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
  const validProjection = (
    value: unknown,
  ): value is OperationCheckpointProjection =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!validProjection(state["projection"]))
    throw new Error("Invalid operation checkpoint projection");
  if (!validProjection(state["baseProjection"]))
    throw new Error("Invalid operation checkpoint base projection");
  return {
    frontier: bigintCheckpointRecord(state["frontier"]),
    pending: state["pending"].map(decodeOperation),
    projection: state["projection"],
    applied: restoreAppliedIdentityIndex(
      stringCheckpointRecord(state["applied"]),
    ),
    replayHead: decodeReplay(state["replayHead"]),
    replayCount: Number(state["replayCount"]),
    replayLastClock:
      state["replayLastClock"] === undefined
        ? undefined
        : decodeClock(state["replayLastClock"]),
    baseProjection: state["baseProjection"],
    baseFrontier: bigintCheckpointRecord(state["baseFrontier"]),
  };
};
