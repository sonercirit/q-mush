import { describe, expect, test } from "vitest";
import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import { createOperation } from "../shared/operation-core";
import { applyOperationIntakeBatch } from "../shared/operation-intake-core";
import {
  initialOperationEntityProjection,
  operationEntityProjectionCodec,
  reduceOperationEntityProjection,
} from "../shared/operation-projection";
import {
  applyOperationList,
  testApplyState,
} from "./operation-core-test-support";

const operation = (
  kind: string,
  payload: unknown,
  options: {
    readonly writer?: string;
    readonly sequence?: bigint;
    readonly parents?: Readonly<Record<string, bigint>>;
    readonly physicalMs?: number;
    readonly entityType?: string;
    readonly entityId?: string;
  } = {},
) => {
  const writerId = options.writer ?? "writer-a";
  const sequence = options.sequence ?? 1n;
  return createOperation({
    operationId: `${writerId}-${sequence.toString()}-${kind}`,
    schemaVersion: 1,
    writerId,
    sequence,
    clock: {
      physicalMs: options.physicalMs ?? Number(sequence),
      logical: 0,
      writerId,
    },
    parents: options.parents ?? {},
    entity: {
      type: options.entityType ?? "workspaces",
      id: options.entityId ?? "workspace-1",
      accountId: "account-1",
    },
    kind,
    payload,
  });
};

const project = (items: readonly ReturnType<typeof operation>[]) =>
  applyOperationList(
    items,
    testApplyState(initialOperationEntityProjection),
    reduceOperationEntityProjection,
  ).projection;

describe("operation entity registry", () => {
  test("fails closed for unknown kinds, mismatched entities, and malformed payloads", () => {
    for (const item of [
      operation("unknown", {}),
      operation("prompt.name.set", { value: "x" }),
      operation("workspace.name.set", { value: "x", extra: true }),
      operation("workspace.name.set", { value: 1 }),
      operation("session.create", {}, { entityType: "agent_sessions" }),
    ])
      expect(() =>
        applyOperationIntakeBatch(
          "non-session",
          testApplyState(initialOperationEntityProjection),
          [{ encoded: "", operation: item }],
          { append: () => undefined, reducer: reduceOperationEntityProjection },
        ),
      ).toThrow(/kind|payload|entity/i);
  });
});

describe("typed operation projection", () => {
  test("converges workspace LWW identity and remove-wins deletion", () => {
    const create = operation(
      "workspace.create",
      { name: "First" },
      { writer: "c" },
    );
    const left = operation(
      "workspace.name.set",
      { value: "Left" },
      {
        writer: "a",
        parents: { c: 1n },
        physicalMs: 2,
      },
    );
    const right = operation(
      "workspace.name.set",
      { value: "Right" },
      {
        writer: "z",
        parents: { c: 1n },
        physicalMs: 2,
      },
    );
    const remove = operation(
      "workspace.delete",
      {},
      {
        writer: "d",
        parents: { c: 1n },
        physicalMs: 3,
      },
    );
    const first = project([right, create, left, remove]);
    const second = project([remove, left, create, right]);
    expect(first).toEqual(second);
    expect(first.workspaces[0]?.id).toBe("workspace-1");
    expect(first.workspaces[0]?.deleted).toBeDefined();
    expect(first.workspaces[0]?.name?.value).toBe("Right");
  });

  test("retains concurrent losing prompt bodies and discards causally covered revisions", () => {
    const create = operation(
      "prompt.create",
      { name: "Prompt", body: "base" },
      { writer: "c", entityType: "prompts", entityId: "prompt-1" },
    );
    const left = operation(
      "prompt.body.set",
      { value: "left" },
      {
        writer: "a",
        parents: { c: 1n },
        physicalMs: 2,
        entityType: "prompts",
        entityId: "prompt-1",
      },
    );
    const right = operation(
      "prompt.body.set",
      { value: "right" },
      {
        writer: "z",
        parents: { c: 1n },
        physicalMs: 2,
        entityType: "prompts",
        entityId: "prompt-1",
      },
    );
    const merged = project([right, create, left]);
    expect(merged.prompts[0]?.body?.value).toBe("right");
    expect(merged.prompts[0]?.bodyConflicts.map((item) => item.value)).toEqual([
      "left",
    ]);
    const resolved = operation(
      "prompt.body.set",
      { value: "resolved" },
      {
        writer: "z",
        sequence: 2n,
        physicalMs: 3,
        parents: { a: 1n, c: 1n, z: 1n },
        entityType: "prompts",
        entityId: "prompt-1",
      },
    );
    expect(
      project([right, resolved, left, create]).prompts[0]?.bodyConflicts,
    ).toEqual([]);
  });

  test("repairs an unavailable requested default by creation clock then ID", () => {
    const workspaceB = operation(
      "workspace.create",
      { name: "B" },
      { writer: "b", physicalMs: 1, entityId: "workspace-b" },
    );
    const workspaceA = operation(
      "workspace.create",
      { name: "A" },
      { writer: "a", physicalMs: 1, entityId: "workspace-a" },
    );
    const userDefault = operation(
      "user.default-workspace.set",
      { defaultWorkspaceId: "missing" },
      { entityType: "users", entityId: "user-1", physicalMs: 2 },
    );
    expect(
      project([workspaceB, userDefault, workspaceA]).users[0]
        ?.effectiveDefaultWorkspaceId,
    ).toBe("workspace-a");
  });
});

describe("operation entity projection codec", () => {
  test("round trips canonically and rejects malformed or noncanonical data", () => {
    const projection = project([
      operation("workspace.create", { name: "One" }),
    ]);
    const encoded = operationEntityProjectionCodec.encode(projection);
    expect(operationEntityProjectionCodec.decode(encoded)).toEqual(projection);
    expect(
      operationEntityProjectionCodec.decode(
        operationEntityProjectionCodec.encode(projection),
      ),
    ).toEqual(projection);
    expect(() =>
      operationEntityProjectionCodec.decode({ ...projection, extra: true }),
    ).toThrow();
    expect(() =>
      operationEntityProjectionCodec.decode({
        ...projection,
        workspaces: [...projection.workspaces, projection.workspaces[0]],
      }),
    ).toThrow();
    expect(() =>
      operationEntityProjectionCodec.decode({
        ...projection,
        workspaces: [
          {
            ...projection.workspaces[0],
            id: "__proto__",
          },
        ],
      }),
    ).toThrow();
    const checkpoint = applyOperationList(
      [operation("workspace.create", { name: "One" })],
      testApplyState(initialOperationEntityProjection),
      reduceOperationEntityProjection,
    );
    const serialized = encodeOperationCheckpoint(
      checkpoint,
      operationEntityProjectionCodec,
    );
    expect(
      decodeOperationCheckpoint(serialized, operationEntityProjectionCodec)
        .projection,
    ).toEqual(projection);
    expect(() =>
      decodeOperationCheckpoint(serialized, {
        encode: (value) => value,
        decode: () => {
          throw new Error("codec mutation");
        },
      }),
    ).toThrow(/projection/);
  });
});
