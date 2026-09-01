import { isDispatchKey } from "./dispatch";

import { exactObjectKeys } from "./validation";

const validString = (value: unknown): value is string =>
  typeof value === "string";
const validNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const payloadWith = (
  value: unknown,
  key: string,
  valid: (item: unknown) => boolean,
): boolean => exactObjectKeys(value, [key]) && valid(value[key]);

interface EntityOperationDefinition {
  readonly entityType: "workspaces" | "prompts" | "users";
  readonly validPayload: (value: unknown) => boolean;
}

const stringValueDefinition = (entityType: "workspaces" | "prompts") => ({
  entityType,
  validPayload: (value: unknown) => payloadWith(value, "value", validString),
});

const definitions = {
  "workspace.create": {
    entityType: "workspaces",
    validPayload: (value) => payloadWith(value, "name", validString),
  },
  "workspace.name.set": stringValueDefinition("workspaces"),
  "workspace.delete": {
    entityType: "workspaces",
    validPayload: (value) => exactObjectKeys(value, []),
  },
  "prompt.create": {
    entityType: "prompts",
    validPayload: (value) =>
      exactObjectKeys(value, ["name", "body"]) &&
      validString(value["name"]) &&
      validString(value["body"]),
  },
  "prompt.name.set": stringValueDefinition("prompts"),
  "prompt.body.set": stringValueDefinition("prompts"),
  "prompt.delete": {
    entityType: "prompts",
    validPayload: (value) => exactObjectKeys(value, []),
  },
  "user.default-workspace.set": {
    entityType: "users",
    validPayload: (value) =>
      payloadWith(value, "defaultWorkspaceId", validNullableString),
  },
} satisfies Record<string, EntityOperationDefinition>;

export const validateEntityOperation = (operation: {
  readonly entity: {
    readonly type: string;
    readonly id: string;
    readonly accountId: string;
  };
  readonly kind: string;
  readonly payload: unknown;
}): string | undefined => {
  if (!isDispatchKey(definitions, operation.kind))
    return "Operation kind is unsupported";
  const definition = definitions[operation.kind];
  if (operation.entity.type !== definition.entityType)
    return "Operation kind does not match entity";
  if (
    operation.kind === "user.default-workspace.set" &&
    operation.entity.id !== operation.entity.accountId
  )
    return "User operation entity must match account";
  if (!definition.validPayload(operation.payload))
    return "Operation payload is invalid";
  return undefined;
};
