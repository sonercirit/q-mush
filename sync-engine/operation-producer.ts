import type { AppDatabase } from "../shared/database";
import { createUuidV7, type IdGenerator } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import {
  compareClocks,
  createOperation,
  MAX_OPERATION_ENVELOPE_BYTES,
  operationProtocolError,
  replayOperationsNewestFirst,
  type CausalFrontier,
  type HybridTimestamp,
  type Operation,
} from "../shared/operation-core";
import { initialOperationApplyState } from "../shared/operation-intake-core";
import {
  initialOperationEntityProjection,
  operationEntityProjectionCodec,
  reduceOperationEntityProjection,
  type OperationEntityProjection,
} from "../shared/operation-projection";
import { utf8ByteLength } from "../shared/utf8";
import {
  createOperationIntake,
  type OperationIntakeLimits,
} from "./operation-intake";
import { createOperationStore } from "./operation-store";

interface LegacyWorkspace {
  readonly id: string;
  readonly name: string;
}
interface EntityIntent {
  readonly type: "entity";
  readonly entity: {
    readonly id: string;
    readonly type: "prompts" | "users" | "workspaces";
  };
  readonly ensureOnly?: boolean;
  readonly kind: string;
  readonly payload: unknown;
  readonly legacy?: { readonly body?: string; readonly name: string };
}
interface AccountIntent {
  readonly type: "account.ensure";
  readonly defaultWorkspace: LegacyWorkspace | null;
}
const entityIntent = (
  entity: EntityIntent["entity"],
  kind: string,
  payload: unknown,
  options: Pick<EntityIntent, "ensureOnly" | "legacy"> = {},
): EntityIntent => ({
  type: "entity",
  entity,
  kind,
  payload,
  ...options,
});
export const operationEntityIntent = (
  type: EntityIntent["entity"]["type"],
  id: string,
  kind: string,
  payload: unknown,
  legacy?: EntityIntent["legacy"],
): EntityIntent =>
  entityIntent({ type, id }, kind, payload, {
    ...(legacy === undefined ? {} : { legacy }),
  });
export const operationEntityEnsureIntent = (
  type: "prompts" | "workspaces",
  id: string,
  legacy: NonNullable<EntityIntent["legacy"]>,
): EntityIntent =>
  entityIntent(
    { type, id },
    type === "workspaces" ? "workspace.create" : "prompt.create",
    type === "workspaces"
      ? { name: legacy.name }
      : { name: legacy.name, body: legacy.body },
    { legacy, ensureOnly: true },
  );
export const operationAccountIntent = (
  defaultWorkspace: LegacyWorkspace | null,
): AccountIntent => ({ type: "account.ensure", defaultWorkspace });

export type OperationProducerIntent = AccountIntent | EntityIntent;

interface OperationProducerResources {
  readonly database: AppDatabase;
  readonly generateId?: IdGenerator;
  readonly limits?: OperationIntakeLimits;
}

const entityOperation = (
  ownerId: string,
  intent: EntityIntent,
  operationId: string,
  sequence: bigint,
  clock: HybridTimestamp,
  parents: CausalFrontier,
): Operation =>
  createOperation({
    operationId,
    schemaVersion: 1,
    writerId: ownerId,
    sequence,
    clock,
    parents,
    entity: { ...intent.entity, accountId: ownerId },
    kind: intent.kind,
    payload: intent.payload,
  });
const createdEntity = (
  projection: OperationEntityProjection,
  intent: EntityIntent,
) =>
  intent.entity.type === "workspaces"
    ? projection.workspaces.find(({ id }) => id === intent.entity.id)
    : projection.prompts.find(({ id }) => id === intent.entity.id);
const createBackfill = (intent: EntityIntent): EntityIntent | undefined => {
  if (
    intent.legacy === undefined ||
    intent.kind.endsWith(".delete") ||
    intent.entity.type === "users"
  )
    return undefined;
  return intent.entity.type === "workspaces"
    ? {
        type: "entity",
        entity: intent.entity,
        kind: "workspace.create",
        payload: { name: intent.legacy.name },
      }
    : intent.legacy.body === undefined
      ? undefined
      : {
          type: "entity",
          entity: intent.entity,
          kind: "prompt.create",
          payload: { name: intent.legacy.name, body: intent.legacy.body },
        };
};
const clockFloor = (
  stableClock: HybridTimestamp | undefined,
  replay: readonly Operation[],
  pending: readonly Operation[],
): HybridTimestamp | undefined => {
  let floor = stableClock;
  for (const { clock } of [...replay, ...pending])
    if (floor === undefined || compareClocks(clock, floor) > 0) floor = clock;
  return floor;
};
const nextClock = (
  ownerId: string,
  now: number,
  floor: HybridTimestamp | undefined,
): HybridTimestamp => {
  const physicalMs = Math.max(now, floor?.physicalMs ?? 0);
  const logical = physicalMs === floor?.physicalMs ? floor.logical + 1 : 0;
  if (!Number.isSafeInteger(physicalMs) || !Number.isSafeInteger(logical))
    throw operationProtocolError(
      "invalid",
      "Operation producer clock overflow",
    );
  return { physicalMs, logical, writerId: ownerId };
};

export const createOperationProducer = (
  resources: OperationProducerResources,
) => {
  const generateId = resources.generateId ?? createUuidV7;
  const store = createOperationStore({ database: resources.database });
  const intake = createOperationIntake(
    resources.limits === undefined
      ? { database: resources.database }
      : { database: resources.database, limits: resources.limits },
  );
  return {
    produce(
      ownerId: string,
      intents: readonly OperationProducerIntent[],
      now: number,
    ): readonly Operation[] {
      const encoded = store.loadCheckpoint(ownerId, "non-session");
      const state =
        encoded === undefined
          ? initialOperationApplyState(initialOperationEntityProjection)
          : decodeOperationCheckpoint(encoded, operationEntityProjectionCodec);
      let projection = state.projection;
      const storedMaximum = store.maximumWriterSequence(
        ownerId,
        "non-session",
        ownerId,
      );
      let sequence =
        (state.frontier[ownerId] ?? 0n) > storedMaximum
          ? (state.frontier[ownerId] ?? 0n) + 1n
          : storedMaximum + 1n;
      let floor = clockFloor(
        state.stableClock,
        replayOperationsNewestFirst(state.replayHead),
        state.pending,
      );
      let parents: CausalFrontier = state.frontier;
      const operations: Operation[] = [];
      const append = (intent: EntityIntent): void => {
        const clock = nextClock(ownerId, now, floor);
        let operation: Operation;
        try {
          operation = entityOperation(
            ownerId,
            intent,
            generateId(now),
            sequence,
            clock,
            parents,
          );
        } catch {
          throw operationProtocolError("invalid", "Invalid produced operation");
        }
        if (
          utf8ByteLength(encodeOperationEnvelope(operation)) >
          MAX_OPERATION_ENVELOPE_BYTES
        )
          throw operationProtocolError(
            "invalid",
            "Produced operation envelope is too large",
          );
        operations.push(operation);
        projection = reduceOperationEntityProjection(projection, operation);
        parents = { ...parents, [ownerId]: sequence };
        sequence += 1n;
        floor = clock;
      };
      const ensureEntity = (intent: EntityIntent): void => {
        const current = createdEntity(projection, intent);
        if (current?.created === undefined && current?.deleted === undefined) {
          const backfill = createBackfill(intent);
          if (backfill !== undefined) append(backfill);
        }
      };
      for (const intent of intents) {
        if (intent.type === "account.ensure") {
          if (projection.users.some(({ id }) => id === ownerId)) continue;
          if (intent.defaultWorkspace !== null) {
            const workspace: EntityIntent = {
              type: "entity",
              entity: { type: "workspaces", id: intent.defaultWorkspace.id },
              kind: "workspace.create",
              payload: { name: intent.defaultWorkspace.name },
              legacy: { name: intent.defaultWorkspace.name },
            };
            ensureEntity(workspace);
          }
          append({
            type: "entity",
            entity: { type: "users", id: ownerId },
            kind: "user.default-workspace.set",
            payload: {
              defaultWorkspaceId: intent.defaultWorkspace?.id ?? null,
            },
          });
          continue;
        }
        ensureEntity(intent);
        if (intent.ensureOnly !== true) append(intent);
      }
      if (operations.length > 0)
        intake.apply(ownerId, "non-session", operations, ownerId, now);
      return operations;
    },
  };
};
