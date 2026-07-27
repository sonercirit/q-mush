import { and, eq, isNull } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import { runners } from "../shared/database/schema.ts";
import { nullableColumnCondition } from "./database-condition.ts";
import { runnerTokenFields } from "./runner-registration-query.ts";
import type { RunnerRegistrationStorePrimitives } from "./runner-registration-store.ts";
import type {
  RunnerMetadata,
  RunnerRegistrationFence,
  RunnerRegistrationPreflight,
  RunnerRegistrationPrepareOptions,
  StoredRunnerRegistration,
} from "./runner-registration-types.ts";

export function registrationSnapshotCondition(
  primitives: RunnerRegistrationStorePrimitives,
  snapshot: StoredRunnerRegistration,
) {
  return and(
    primitives.activeRunnerCondition({
      id: snapshot.id,
      userId: snapshot.userId,
    }),
    eq(runners.activationGeneration, snapshot.activationGeneration),
    nullableColumnCondition(runners.activationId, snapshot.activationId),
    nullableColumnCondition(
      runners.activationReservationId,
      snapshot.activationReservationId,
    ),
    nullableColumnCondition(
      runners.activationReservationSourceId,
      snapshot.activationReservationSourceId,
    ),
    snapshot.activationReservationGeneration === null
      ? isNull(runners.activationReservationGeneration)
      : eq(
          runners.activationReservationGeneration,
          snapshot.activationReservationGeneration,
        ),
    eq(runners.tokenDigest, snapshot.tokenDigest),
    eq(runners.tokenHash, snapshot.tokenHash),
    snapshot.machineFingerprint === null
      ? isNull(runners.machineFingerprint)
      : eq(runners.machineFingerprint, snapshot.machineFingerprint),
  );
}

export function durableRegistrationFence(
  registration: StoredRunnerRegistration,
): RunnerRegistrationFence | undefined {
  const lifecycle = registration.activationLifecycle;
  const phase = registration.activationPhase;
  const generation = registration.activationGeneration;
  const sourceId = registration.activationSourceId;
  const activationId = registration.activationId;
  return activationId === null ||
    lifecycle === null ||
    phase === null ||
    sourceId === null ||
    registration.activationTargetId === null ||
    registration.activationTargetGeneration === null ||
    registration.activationReservationId !== activationId ||
    registration.activationReservationGeneration !== generation ||
    registration.activationReservationSourceId !== sourceId ||
    registration.activationMachineFingerprint === null ||
    registration.activationArchitecture === null ||
    registration.activationName === null ||
    registration.activationPlatform === null
    ? undefined
    : {
        activationId,
        architecture: registration.activationArchitecture,
        generation,
        lifecycle,
        machineFingerprint: registration.activationMachineFingerprint,
        name: registration.activationName,
        phase,
        platform: registration.activationPlatform,
        restartId: registration.activationRestartId ?? undefined,
        sourceId,
        targetGeneration: registration.activationTargetGeneration,
        targetId: registration.activationTargetId,
        ...runnerTokenFields(registration),
      };
}

export function createReservationValues(
  preflight: RunnerRegistrationPreflight,
  options: RunnerRegistrationPrepareOptions,
  generation: number,
) {
  return {
    ...updatedAuditFields(preflight.source.userId, options.now),
    activationArchitecture: preflight.metadata.architecture,
    activationGeneration: generation,
    activationId: preflight.activationId,
    activationLifecycle: options.lifecycle,
    activationLifecycleSettled: false,
    activationMachineFingerprint: preflight.metadata.machineFingerprint,
    activationName: preflight.metadata.name,
    activationPhase: "prepared" as const,
    activationPlatform: preflight.metadata.platform,
    activationReservationGeneration: generation,
    activationReservationId: preflight.activationId,
    activationReservationSourceId: preflight.source.id,
    activationRestartId: options.restartId ?? null,
    activationSourceId: preflight.source.id,
    activationTargetGeneration: preflight.target.activationGeneration,
    activationTargetId: preflight.target.id,
  };
}

export function createPreparedRegistration(
  source: StoredRunnerRegistration,
  metadata: RunnerMetadata,
): RunnerRegistrationPreflight | undefined {
  const fence = durableRegistrationFence(source);
  if (
    (fence?.phase !== "prepared" && fence?.phase !== "finalized") ||
    fence.architecture !== metadata.architecture ||
    fence.machineFingerprint !== metadata.machineFingerprint ||
    fence.name !== metadata.name ||
    fence.platform !== metadata.platform
  ) {
    return undefined;
  }
  return {
    activationId: fence.activationId,
    metadata,
    source,
    target: source,
    tokenDigest: source.tokenDigest,
  };
}
