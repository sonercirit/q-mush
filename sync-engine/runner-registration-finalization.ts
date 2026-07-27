import { and, eq } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import { runners } from "../shared/database/schema.ts";
import { nullableColumnCondition } from "./database-condition.ts";
import { exactlyOneRow, exactlyOneUpdatedRow } from "./database-update.ts";
import type { RunnerLifecycleParameters } from "./runner-registration-parameters.ts";
import {
  registrationTargetCondition,
  reservationCondition,
  runnerIdSelection,
  storedRunnerConnection,
  storedRunnerId,
  storedRunnerRegistration,
} from "./runner-registration-query.ts";
import type { RunnerRegistrationStoreContext } from "./runner-registration-store.ts";
import type {
  RunnerConnection,
  RunnerRegistrationActivationResult,
  RunnerRegistrationFence,
  RunnerRegistrationFinalizeOptions,
} from "./runner-registration-types.ts";

const REGISTRATION_CHANGED = { status: "registration_changed" } as const;

function finalizedFence(
  fence: RunnerRegistrationFence,
): RunnerRegistrationFence {
  return { ...fence, phase: "finalized" };
}

function activated(connection: RunnerConnection) {
  return { connection, status: "activated" as const };
}

function activationIdentityCondition(
  fence: RunnerRegistrationFence,
  phase: RunnerRegistrationFence["phase"],
) {
  return and(
    eq(runners.activationPhase, phase),
    eq(runners.activationLifecycle, fence.lifecycle),
    nullableColumnCondition(runners.activationRestartId, fence.restartId),
    eq(runners.activationSourceId, fence.sourceId),
    eq(runners.activationTargetId, fence.targetId),
    eq(runners.activationTargetGeneration, fence.targetGeneration),
  );
}

function activationMetadataCondition(fence: RunnerRegistrationFence) {
  return and(
    eq(runners.activationMachineFingerprint, fence.machineFingerprint),
    eq(runners.activationArchitecture, fence.architecture),
    eq(runners.activationName, fence.name),
    eq(runners.activationPlatform, fence.platform),
    eq(runners.tokenDigest, fence.tokenDigest),
    eq(runners.tokenHash, fence.tokenHash),
  );
}

function activationVersionCondition(fence: RunnerRegistrationFence) {
  return and(
    eq(runners.activationGeneration, fence.generation),
    eq(runners.activationId, fence.activationId),
  );
}

export function durableActivationCondition(
  fence: RunnerRegistrationFence,
  phase = fence.phase,
) {
  return and(
    eq(runners.id, fence.sourceId),
    eq(runners.userId, fence.userId),
    activationVersionCondition(fence),
    activationIdentityCondition(fence, phase),
    reservationCondition(fence),
    activationMetadataCondition(fence),
  );
}

function targetReservationCondition(
  fence: RunnerRegistrationFence,
  generation = fence.targetGeneration,
) {
  return registrationTargetCondition(fence, generation);
}

function finalizedTargetCondition(fence: RunnerRegistrationFence) {
  return and(
    targetReservationCondition(fence, fence.generation),
    activationVersionCondition(fence),
    activationIdentityCondition(fence, "finalized"),
    activationMetadataCondition(fence),
  );
}

export function durableTargetCondition(fence: RunnerRegistrationFence) {
  if (fence.phase === "finalized") {
    return finalizedTargetCondition(fence);
  }
  return fence.targetId === fence.sourceId
    ? and(
        durableActivationCondition(fence, "prepared"),
        eq(runners.isDeleted, false),
      )
    : targetReservationCondition(fence);
}

function targetHasNotChanged(
  context: RunnerRegistrationStoreContext,
  fence: RunnerRegistrationFence,
) {
  return (
    storedRunnerId(context.database, durableTargetCondition(fence)) !==
    undefined
  );
}

function finalizedSourceCondition(fence: RunnerRegistrationFence) {
  return and(
    durableActivationCondition(finalizedFence(fence)),
    eq(runners.isDeleted, fence.sourceId !== fence.targetId),
  );
}

function finalizedConnection(
  context: RunnerRegistrationStoreContext,
  fence: RunnerRegistrationFence,
): RunnerConnection | undefined {
  const source = storedRunnerId(
    context.database,
    finalizedSourceCondition(fence),
  );
  if (source === undefined) {
    return undefined;
  }
  return storedRunnerConnection(
    context.database,
    durableTargetCondition(finalizedFence(fence)),
  );
}

export function finalizeRunnerRegistration(
  context: RunnerRegistrationStoreContext,
  fence: RunnerRegistrationFence,
  options: RunnerRegistrationFinalizeOptions,
): RunnerRegistrationActivationResult {
  if (!context.receiptMatches(fence, options.receipt)) {
    return REGISTRATION_CHANGED;
  }
  const replay = finalizedConnection(context, fence);
  if (replay !== undefined) {
    return activated(replay);
  }
  if (fence.phase !== "prepared" || !targetHasNotChanged(context, fence)) {
    return REGISTRATION_CHANGED;
  }
  return context.database.transaction((transaction) => {
    if (fence.targetId === fence.sourceId) {
      const alreadyFinalized = storedRunnerConnection(
        transaction,
        durableTargetCondition(finalizedFence(fence)),
      );
      if (alreadyFinalized !== undefined) {
        return activated(alreadyFinalized);
      }
      const finalized = transaction
        .update(runners)
        .set({
          ...updatedAuditFields(fence.userId, options.now),
          activationPhase: "finalized",
          architecture: fence.architecture,
          lastSeenAt: new Date(options.now),
          machineFingerprint: fence.machineFingerprint,
          name: fence.name,
          platform: fence.platform,
        })
        .where(durableActivationCondition(fence, "prepared"))
        .returning({ id: runners.id, userId: runners.userId })
        .all();
      const connection = exactlyOneRow(finalized);
      return connection === undefined
        ? REGISTRATION_CHANGED
        : activated(connection);
    }
    const source = transaction
      .select(context.runnerRegistrationSelection())
      .from(runners)
      .where(durableActivationCondition(fence, "prepared"))
      .get();
    if (source === undefined) {
      const alreadyFinalized = storedRunnerRegistration(
        transaction,
        context.runnerRegistrationSelection(),
        finalizedSourceCondition(fence),
      );
      const connection =
        alreadyFinalized === undefined
          ? undefined
          : storedRunnerConnection(
              transaction,
              durableTargetCondition(finalizedFence(fence)),
            );
      return connection === undefined
        ? REGISTRATION_CHANGED
        : activated(connection);
    }
    const applied = context.applyFinalizedReservation(
      transaction,
      source,
      options.now,
    );
    if (applied === undefined) {
      return REGISTRATION_CHANGED;
    }
    const finalizedSourceExists = storedRunnerId(
      transaction,
      finalizedSourceCondition(fence),
    );
    if (finalizedSourceExists === undefined) {
      throw new Error("The applied runner activation could not be finalized");
    }
    return activated(applied);
  });
}

export function settleActivationLifecycleParameters(
  settle: (...parameters: RunnerLifecycleParameters) => boolean,
  parameters: RunnerLifecycleParameters,
): boolean {
  return settle(...parameters);
}

export function settleRunnerActivationLifecycle(
  context: RunnerRegistrationStoreContext,
  activationId: string,
  lifecycle: RunnerRegistrationFence["lifecycle"],
  restartId?: string,
): boolean {
  const condition = (settled: boolean) =>
    and(
      eq(runners.activationId, activationId),
      eq(runners.activationPhase, "finalized"),
      eq(runners.activationLifecycle, lifecycle),
      eq(runners.activationLifecycleSettled, settled),
      eq(runners.isDeleted, false),
      nullableColumnCondition(runners.activationRestartId, restartId),
    );
  const lifecycleUpdated = exactlyOneUpdatedRow(
    context.database,
    runners,
    { activationLifecycleSettled: true },
    condition(false),
    runners.id,
  );
  return (
    lifecycleUpdated ||
    context.database
      .select(runnerIdSelection())
      .from(runners)
      .where(condition(true))
      .get() !== undefined
  );
}

export function touchFinalizedRunnerActivation(
  context: RunnerRegistrationStoreContext,
  fence: RunnerRegistrationFence,
  now: number,
): RunnerConnection | undefined {
  if (fence.phase !== "finalized") {
    return undefined;
  }
  const source = context.database
    .select(context.runnerRegistrationSelection())
    .from(runners)
    .where(
      and(
        durableActivationCondition(fence, "finalized"),
        fence.sourceId === fence.targetId
          ? eq(runners.isDeleted, false)
          : eq(runners.isDeleted, true),
      ),
    )
    .get();

  if (source === undefined) {
    return undefined;
  }
  return context.database.transaction((transaction) =>
    context.applyFinalizedReservation(transaction, source, now, true),
  );
}
