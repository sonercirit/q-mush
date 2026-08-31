import type { OperationProjectionCodec } from "./operation-checkpoint";
import {
  compareClocks,
  operationFingerprint,
  type HybridTimestamp,
  type Operation,
} from "./operation-core";
import { exactObjectKeys } from "./validation";

interface ProjectionWrite<T> {
  readonly value: T;
  readonly operationId: string;
  readonly writerId: string;
  readonly sequence: bigint;
  readonly clock: HybridTimestamp;
}
interface NamedEntityProjection {
  readonly id: string;
  readonly created: ProjectionWrite<true> | undefined;
  readonly name: ProjectionWrite<string> | undefined;
  readonly deleted: ProjectionWrite<true> | undefined;
}
type WorkspaceProjection = NamedEntityProjection;
interface PromptProjection extends NamedEntityProjection {
  readonly body: ProjectionWrite<string> | undefined;
  readonly bodyConflicts: readonly ProjectionWrite<string>[];
}
interface UserProjection {
  readonly id: string;
  readonly defaultWorkspaceId: ProjectionWrite<string | null> | undefined;
  readonly effectiveDefaultWorkspaceId: string | null;
}
export interface OperationEntityProjection {
  readonly workspaces: readonly WorkspaceProjection[];
  readonly prompts: readonly PromptProjection[];
  readonly users: readonly UserProjection[];
}

export const initialOperationEntityProjection: OperationEntityProjection = {
  workspaces: [],
  prompts: [],
  users: [],
};

const write = <T>(operation: Operation, value: T): ProjectionWrite<T> => ({
  value,
  operationId: operation.operationId,
  writerId: operation.writerId,
  sequence: operation.sequence,
  clock: operation.clock,
});
const coveredBy = (candidate: ProjectionWrite<unknown>, operation: Operation) =>
  Object.hasOwn(operation.parents, candidate.writerId) &&
  (operation.parents[candidate.writerId] ?? 0n) >= candidate.sequence;
const byId = <T extends { readonly id: string }>(left: T, right: T) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const replaceById = <T extends { readonly id: string }>(
  items: readonly T[],
  item: T,
): readonly T[] =>
  [...items.filter(({ id }) => id !== item.id), item].sort(byId);
const payloadField = (operation: Operation, key: string): unknown => {
  const payload = operation.payload;
  return payload !== null && typeof payload === "object"
    ? Reflect.get(payload, key)
    : undefined;
};
const payloadString = (
  operation: Operation,
  key: "name" | "body" | "value",
): string => {
  const value = payloadField(operation, key);
  return typeof value === "string" ? value : "";
};
const emptyNamedEntity = (id: string): NamedEntityProjection => ({
  id,
  created: undefined,
  name: undefined,
  deleted: undefined,
});
const workspaceRecord = (
  projection: OperationEntityProjection,
  id: string,
): WorkspaceProjection =>
  projection.workspaces.find((item) => item.id === id) ?? emptyNamedEntity(id);
const promptRecord = (
  projection: OperationEntityProjection,
  id: string,
): PromptProjection =>
  projection.prompts.find((item) => item.id === id) ?? {
    ...emptyNamedEntity(id),
    body: undefined,
    bodyConflicts: [],
    deleted: undefined,
  };
const effectiveDefault = (
  workspaces: readonly WorkspaceProjection[],
  requested: string | null | undefined,
): string | null => {
  const active = workspaces.filter(
    (item): item is WorkspaceProjection & { created: ProjectionWrite<true> } =>
      item.created !== undefined && item.deleted === undefined,
  );
  if (
    requested !== null &&
    requested !== undefined &&
    active.some(({ id }) => id === requested)
  )
    return requested;
  return (
    [...active].sort(
      (left, right) =>
        compareClocks(left.created.clock, right.created.clock) ||
        byId(left, right),
    )[0]?.id ?? null
  );
};
const repairUsers = (
  projection: OperationEntityProjection,
): OperationEntityProjection => ({
  ...projection,
  users: projection.users.map((user) => ({
    ...user,
    effectiveDefaultWorkspaceId: effectiveDefault(
      projection.workspaces,
      user.defaultWorkspaceId?.value,
    ),
  })),
});
const updateWorkspaces = (
  projection: OperationEntityProjection,
  item: WorkspaceProjection,
): OperationEntityProjection =>
  repairUsers({
    ...projection,
    workspaces: replaceById(projection.workspaces, item),
  });
const updatePrompts = (
  projection: OperationEntityProjection,
  item: PromptProjection,
): OperationEntityProjection => ({
  ...projection,
  prompts: replaceById(projection.prompts, item),
});
const createNamedEntity = (
  current: NamedEntityProjection,
  operation: Operation,
): NamedEntityProjection => ({
  ...current,
  created: current.created ?? write(operation, true),
  name: current.name ?? write(operation, payloadString(operation, "name")),
});
const namedPayloadWrite = <T extends NamedEntityProjection>(
  current: T,
  operation: Operation,
): T & NamedEntityProjection => ({
  ...current,
  name: write(operation, payloadString(operation, "value")),
});
const deleteNamedEntity = <T extends NamedEntityProjection>(
  operation: Operation,
  current: T,
): T & NamedEntityProjection =>
  Object.assign({}, current, { deleted: write<true>(operation, true) });
const reduceWorkspace = (
  projection: OperationEntityProjection,
  operation: Operation,
): OperationEntityProjection => {
  const current = workspaceRecord(projection, operation.entity.id);
  const next: WorkspaceProjection =
    operation.kind === "workspace.create"
      ? current.deleted !== undefined
        ? current
        : createNamedEntity(current, operation)
      : operation.kind === "workspace.name.set"
        ? current.created === undefined || current.deleted !== undefined
          ? current
          : namedPayloadWrite(current, operation)
        : deleteNamedEntity(operation, current);
  return updateWorkspaces(projection, next);
};
const reducePrompt = (
  projection: OperationEntityProjection,
  operation: Operation,
): OperationEntityProjection => {
  const current = promptRecord(projection, operation.entity.id);
  if (operation.kind === "prompt.create") {
    if (current.deleted !== undefined) return projection;
    const named = createNamedEntity(current, operation);
    const next = {
      ...current,
      ...named,
      body: current.body ?? write(operation, payloadString(operation, "body")),
    };
    return updatePrompts(projection, next);
  }
  if (operation.kind === "prompt.delete") {
    return updatePrompts(projection, deleteNamedEntity(operation, current));
  }
  if (current.created === undefined || current.deleted !== undefined)
    return projection;
  if (operation.kind === "prompt.name.set")
    return updatePrompts(projection, namedPayloadWrite(current, operation));
  const nextBody = write(operation, payloadString(operation, "value"));
  const candidates = [
    ...current.bodyConflicts,
    ...(current.body !== undefined && !coveredBy(current.body, operation)
      ? [current.body]
      : []),
  ].filter((item) => !coveredBy(item, operation));
  const unique = new Map(candidates.map((item) => [item.operationId, item]));
  const conflicts = [...unique.values()].sort(
    (left, right) =>
      compareClocks(left.clock, right.clock) ||
      (left.operationId < right.operationId ? -1 : 1),
  );
  return updatePrompts(projection, {
    ...current,
    body: nextBody,
    bodyConflicts: conflicts,
  });
};
const reduceUser = (
  projection: OperationEntityProjection,
  operation: Operation,
): OperationEntityProjection => {
  const current = projection.users.find(({ id }) => id === operation.entity.id);
  const requested = payloadField(operation, "defaultWorkspaceId");
  const value = typeof requested === "string" ? requested : null;
  return repairUsers({
    ...projection,
    users: replaceById(projection.users, {
      id: operation.entity.id,
      defaultWorkspaceId: write(operation, value),
      effectiveDefaultWorkspaceId: current?.effectiveDefaultWorkspaceId ?? null,
    }),
  });
};

export const reduceOperationEntityProjection = (
  projection: OperationEntityProjection,
  operation: Operation,
): OperationEntityProjection =>
  operation.entity.type === "workspaces"
    ? reduceWorkspace(projection, operation)
    : operation.entity.type === "prompts"
      ? reducePrompt(projection, operation)
      : reduceUser(projection, operation);

const projectionKeys = ["workspaces", "prompts", "users"] as const;
const safeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "__proto__" &&
  value !== "prototype" &&
  value !== "constructor";
const validClock = (value: unknown): value is HybridTimestamp =>
  exactObjectKeys(value, ["physicalMs", "logical", "writerId"]) &&
  Number.isSafeInteger(value["physicalMs"]) &&
  Number(value["physicalMs"]) >= 0 &&
  Number.isSafeInteger(value["logical"]) &&
  Number(value["logical"]) >= 0 &&
  safeId(value["writerId"]);
const validWrite = (
  value: unknown,
  validValue: (item: unknown) => boolean,
): value is ProjectionWrite<never> =>
  exactObjectKeys(value, [
    "value",
    "operationId",
    "writerId",
    "sequence",
    "clock",
  ]) &&
  validValue(value["value"]) &&
  safeId(value["operationId"]) &&
  safeId(value["writerId"]) &&
  typeof value["sequence"] === "bigint" &&
  value["sequence"] > 0n &&
  validClock(value["clock"]) &&
  value["clock"].writerId === value["writerId"];
const optionalWrite = (
  value: unknown,
  validValue: (item: unknown) => boolean,
) => value === undefined || validWrite(value, validValue);
const canonicalItems = (items: readonly { readonly id: string }[]) =>
  items.every(
    (item, index) => index === 0 || (items[index - 1]?.id ?? "") < item.id,
  );

type EncodedOperationEntityProjection = OperationEntityProjection;
const encodeOperationEntityProjection = (
  projection: OperationEntityProjection,
): EncodedOperationEntityProjection =>
  decodeOperationEntityProjection(projection);
const validNamedWrites = (item: Record<string, unknown>): boolean =>
  safeId(item["id"]) &&
  optionalWrite(item["created"], (entry) => entry === true) &&
  optionalWrite(item["name"], (entry) => typeof entry === "string") &&
  optionalWrite(item["deleted"], (entry) => entry === true);
const validProjectionEntity = <T>(
  item: unknown,
  keys: readonly string[],
  valid: (record: Record<string, unknown>) => boolean,
): item is T => exactObjectKeys(item, keys) && valid(item);
const validWorkspace = (item: unknown): item is WorkspaceProjection =>
  validProjectionEntity<WorkspaceProjection>(
    item,
    ["id", "created", "name", "deleted"],
    validNamedWrites,
  );
const validPrompt = (item: unknown): item is PromptProjection =>
  validProjectionEntity<PromptProjection>(
    item,
    ["id", "created", "name", "body", "bodyConflicts", "deleted"],
    (record) =>
      validNamedWrites(record) &&
      optionalWrite(record["body"], (entry) => typeof entry === "string") &&
      Array.isArray(record["bodyConflicts"]) &&
      record["bodyConflicts"].every((entry) =>
        validWrite(entry, (body) => typeof body === "string"),
      ),
  );
const validUser = (item: unknown): item is UserProjection =>
  exactObjectKeys(item, [
    "id",
    "defaultWorkspaceId",
    "effectiveDefaultWorkspaceId",
  ]) &&
  safeId(item["id"]) &&
  optionalWrite(
    item["defaultWorkspaceId"],
    (entry) => entry === null || typeof entry === "string",
  ) &&
  (item["effectiveDefaultWorkspaceId"] === null ||
    safeId(item["effectiveDefaultWorkspaceId"]));

const decodeOperationEntityProjection = (
  value: unknown,
): OperationEntityProjection => {
  if (
    !exactObjectKeys(value, projectionKeys) ||
    !Array.isArray(value["workspaces"]) ||
    !Array.isArray(value["prompts"]) ||
    !Array.isArray(value["users"])
  )
    throw new Error("Invalid entity projection");
  const workspaces = value["workspaces"];
  const prompts = value["prompts"];
  const users = value["users"];
  if (
    !workspaces.every(validWorkspace) ||
    !prompts.every(validPrompt) ||
    !users.every(validUser) ||
    !canonicalItems(workspaces) ||
    !canonicalItems(prompts) ||
    !canonicalItems(users)
  )
    throw new Error("Invalid entity projection records");
  const result = { workspaces, prompts, users };
  if (
    operationFingerprint(repairUsers(result).users) !==
    operationFingerprint(users)
  )
    throw new Error("Invalid entity projection effective default");
  for (const prompt of prompts) {
    const conflictOrder = prompt.bodyConflicts.every((item, index) => {
      const previous = prompt.bodyConflicts[index - 1];
      return (
        previous === undefined ||
        compareClocks(previous.clock, item.clock) < 0 ||
        (compareClocks(previous.clock, item.clock) === 0 &&
          previous.operationId < item.operationId)
      );
    });
    if (
      !conflictOrder ||
      prompt.bodyConflicts.some(
        ({ operationId }) => operationId === prompt.body?.operationId,
      ) ||
      new Set(prompt.bodyConflicts.map(({ operationId }) => operationId))
        .size !== prompt.bodyConflicts.length
    )
      throw new Error("Invalid entity projection conflicts");
  }
  return result;
};
export const operationEntityProjectionCodec: OperationProjectionCodec<OperationEntityProjection> =
  {
    encode: encodeOperationEntityProjection,
    decode: decodeOperationEntityProjection,
  };
