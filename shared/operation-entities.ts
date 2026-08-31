import { isDispatchKey } from "./dispatch";

const exactObject = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const validString = (value: unknown): value is string =>
  typeof value === "string";
const validNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const payloadWith = (
  value: unknown,
  key: string,
  valid: (item: unknown) => boolean,
): boolean => exactObject(value, [key]) && valid(value[key]);

interface EntityOperationDefinition {
  readonly entityType: "workspaces" | "prompts" | "users";
  readonly validPayload: (value: unknown) => boolean;
}

const definitions = {
  "workspace.create": {
    entityType: "workspaces",
    validPayload: (value) => payloadWith(value, "name", validString),
  },
  "workspace.name.set": {
    entityType: "workspaces",
    validPayload: (value) => payloadWith(value, "value", validString),
  },
  "workspace.delete": {
    entityType: "workspaces",
    validPayload: (value) => exactObject(value, []),
  },
  "prompt.create": {
    entityType: "prompts",
    validPayload: (value) =>
      exactObject(value, ["name", "body"]) &&
      validString(value["name"]) &&
      validString(value["body"]),
  },
  "prompt.name.set": {
    entityType: "prompts",
    validPayload: (value) => payloadWith(value, "value", validString),
  },
  "prompt.body.set": {
    entityType: "prompts",
    validPayload: (value) => payloadWith(value, "value", validString),
  },
  "prompt.delete": {
    entityType: "prompts",
    validPayload: (value) => exactObject(value, []),
  },
  "user.default-workspace.set": {
    entityType: "users",
    validPayload: (value) =>
      payloadWith(value, "defaultWorkspaceId", validNullableString),
  },
} satisfies Record<string, EntityOperationDefinition>;

export const validateEntityOperation = (operation: {
  readonly entity: { readonly type: string };
  readonly kind: string;
  readonly payload: unknown;
}): string | undefined => {
  if (!isDispatchKey(definitions, operation.kind))
    return "Operation kind is unsupported";
  const definition = definitions[operation.kind];
  if (operation.entity.type !== definition.entityType)
    return "Operation kind does not match entity";
  if (!definition.validPayload(operation.payload))
    return "Operation payload is invalid";
  return undefined;
};
