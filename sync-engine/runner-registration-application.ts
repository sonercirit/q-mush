import { and, eq, not, type SQL } from "drizzle-orm";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "../shared/audit.ts";
import { runners, runnerWorkspaces } from "../shared/database/schema.ts";
import { createUuidV7 } from "../shared/ids.ts";
import { exactlyOneUpdatedRow } from "./database-update.ts";
import {
  durableActivationCondition,
  durableTargetCondition,
} from "./runner-registration-finalization.ts";
import { reservationCondition } from "./runner-registration-query.ts";
import type {
  RunnerRegistrationStoreContext,
  RunnerRegistrationTransaction,
} from "./runner-registration-store.ts";
import type {
  RunnerConnection,
  RunnerRegistrationFence,
  StoredRunnerRegistration,
} from "./runner-registration-types.ts";

function runnerScopeCondition(
  source: StoredRunnerRegistration,
  runnerId: string,
) {
  return and(
    eq(runnerWorkspaces.userId, source.userId),
    eq(runnerWorkspaces.runnerId, runnerId),
    not(runnerWorkspaces.isDeleted),
  );
}

function transferRunnerScopes(
  transaction: RunnerRegistrationTransaction,
  source: StoredRunnerRegistration,
  targetId: string,
  now: number,
): void {
  const sourceScopes = transaction
    .select({ workspaceId: runnerWorkspaces.workspaceId })
    .from(runnerWorkspaces)
    .where(runnerScopeCondition(source, source.id))
    .all();
  transaction
    .update(runnerWorkspaces)
    .set(softDeletedAuditFields(source.userId, now))
    .where(runnerScopeCondition(source, source.id))
    .run();
  transaction
    .update(runnerWorkspaces)
    .set({ isDeleted: true, ...updatedAuditFields(source.userId, now) })
    .where(runnerScopeCondition(source, targetId))
    .run();
  for (const { workspaceId } of sourceScopes) {
    const existing = transaction
      .select({ id: runnerWorkspaces.id })
      .from(runnerWorkspaces)
      .where(
        and(
          eq(runnerWorkspaces.userId, source.userId),
          eq(runnerWorkspaces.runnerId, targetId),
          eq(runnerWorkspaces.workspaceId, workspaceId),
        ),
      )
      .get();
    if (existing !== undefined) {
      transaction
        .update(runnerWorkspaces)
        .set({ isDeleted: false, ...updatedAuditFields(source.userId, now) })
        .where(eq(runnerWorkspaces.id, existing.id))
        .run();
      continue;
    }
    transaction
      .insert(runnerWorkspaces)
      .values({
        ...createdAuditFields(source.userId, now),
        id: createUuidV7(now),
        runnerId: targetId,
        userId: source.userId,
        workspaceId,
      })
      .run();
  }
}

function targetReservationCondition(
  context: RunnerRegistrationStoreContext,
  fence: RunnerRegistrationFence,
): SQL | undefined {
  return and(
    context.activeRunnerCondition({
      id: fence.targetId,
      userId: fence.userId,
    }),
    reservationCondition(fence),
  );
}

function touchRunner(
  context: RunnerRegistrationStoreContext,
  transaction: RunnerRegistrationTransaction,
  condition: SQL | undefined,
  now: number,
): StoredRunnerRegistration | undefined {
  return transaction
    .update(runners)
    .set({ lastSeenAt: new Date(now) })
    .where(condition)
    .returning(context.runnerRegistrationSelection())
    .get();
}

export function applyFinalizedRunnerReservation(
  context: RunnerRegistrationStoreContext,
  transaction: RunnerRegistrationTransaction,
  source: StoredRunnerRegistration,
  now: number,
  touchOnly = false,
): RunnerConnection | undefined {
  const fence = context.durableFence(source);
  if (
    fence === undefined ||
    (touchOnly ? fence.phase !== "finalized" : fence.phase !== "prepared")
  ) {
    return undefined;
  }
  const targetId = fence.targetId;
  if (touchOnly) {
    const touched = touchRunner(
      context,
      transaction,
      durableTargetCondition(fence),
      now,
    );
    return touched === undefined
      ? undefined
      : { id: touched.id, userId: touched.userId };
  }
  const targetReservation = and(
    targetReservationCondition(context, fence),
    eq(runners.activationGeneration, fence.targetGeneration),
    eq(runners.isDeleted, false),
  );
  if (fence.targetId !== fence.sourceId) {
    const target = transaction
      .select(context.runnerRegistrationSelection())
      .from(runners)
      .where(targetReservation)
      .get();
    if (target === undefined) {
      return undefined;
    }
    const sourceReleased = exactlyOneUpdatedRow(
      transaction,
      runners,
      {
        ...softDeletedAuditFields(fence.userId, now),
        activationPhase: "finalized",
      },
      durableActivationCondition(fence, "prepared"),
      runners.id,
    );
    if (!sourceReleased) {
      return undefined;
    }
    transferRunnerScopes(transaction, source, targetId, now);
    const tokenRotated = exactlyOneUpdatedRow(
      transaction,
      runners,
      {
        ...updatedAuditFields(fence.userId, now),
        architecture: fence.architecture,
        isGlobal: source.isGlobal,
        machineFingerprint: fence.machineFingerprint,
        name: fence.name,
        platform: fence.platform,
        tokenDigest: fence.tokenDigest,
        tokenHash: fence.tokenHash,
        activationArchitecture: fence.architecture,
        activationGeneration: fence.generation,
        activationId: fence.activationId,
        activationLifecycle: fence.lifecycle,
        activationLifecycleSettled: false,
        activationMachineFingerprint: fence.machineFingerprint,
        activationName: fence.name,
        activationPhase: "finalized",
        activationPlatform: fence.platform,
        activationReservationGeneration: fence.generation,
        activationReservationId: fence.activationId,
        activationReservationSourceId: fence.sourceId,
        activationRestartId: fence.restartId ?? null,
        activationSourceId: fence.sourceId,
        activationTargetGeneration: fence.targetGeneration,
        activationTargetId: fence.targetId,
      },
      targetReservation,
      runners.id,
    );
    if (!tokenRotated) {
      throw new Error("The finalized runner token could not be rotated");
    }
  }

  const stored = touchRunner(
    context,
    transaction,
    context.activeRunnerCondition({ id: targetId, userId: fence.userId }),
    now,
  );
  const durableFence =
    stored === undefined ? undefined : context.durableFence(stored);
  return stored !== undefined &&
    durableFence?.activationId === fence.activationId
    ? { id: stored.id, userId: stored.userId }
    : undefined;
}
