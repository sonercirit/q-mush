import { and, eq, type SQL } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";
import { runners } from "../shared/database/schema.ts";
import { selectedString } from "./database-count.ts";
import type {
  RunnerRegistrationFence,
  StoredRunnerRegistration,
} from "./runner-registration-types.ts";

function runnerConnectionSelection() {
  return { id: runners.id, userId: runners.userId };
}

export function runnerRegistrationSelection() {
  return {
    activationArchitecture: runners.activationArchitecture,
    activationGeneration: runners.activationGeneration,
    activationId: runners.activationId,
    activationLifecycle: runners.activationLifecycle,
    activationLifecycleSettled: runners.activationLifecycleSettled,
    activationMachineFingerprint: runners.activationMachineFingerprint,
    activationName: runners.activationName,
    activationPhase: runners.activationPhase,
    activationPlatform: runners.activationPlatform,
    activationReservationGeneration: runners.activationReservationGeneration,
    activationReservationId: runners.activationReservationId,
    activationReservationSourceId: runners.activationReservationSourceId,
    activationRestartId: runners.activationRestartId,
    activationSourceId: runners.activationSourceId,
    activationTargetGeneration: runners.activationTargetGeneration,
    activationTargetId: runners.activationTargetId,
    architecture: runners.architecture,
    id: runners.id,
    isGlobal: runners.isGlobal,
    machineFingerprint: runners.machineFingerprint,
    name: runners.name,
    platform: runners.platform,
    tokenDigest: runners.tokenDigest,
    tokenHash: runners.tokenHash,
    userId: runners.userId,
  };
}

export function runnerTokenFields<
  TokenDigest,
  TokenHash,
  UserId,
>(registration: {
  readonly tokenDigest: TokenDigest;
  readonly tokenHash: TokenHash;
  readonly userId: UserId;
}) {
  return {
    tokenDigest: registration.tokenDigest,
    tokenHash: registration.tokenHash,
    userId: registration.userId,
  };
}

export function runnerTokenSelection() {
  const registration = runnerRegistrationSelection();
  return {
    id: registration.id,
    machineFingerprint: registration.machineFingerprint,
    ...runnerTokenFields(registration),
  };
}

function registrationTargetIdentityConditions(
  fence: RunnerRegistrationFence,
  userScoped: boolean,
) {
  return [
    eq(runners.id, fence.targetId),
    userScoped ? eq(runners.userId, fence.userId) : undefined,
    eq(runners.isDeleted, false),
  ] as const;
}

export function registrationTargetCondition(
  fence: RunnerRegistrationFence,
  generation: number,
) {
  const conditions = [
    ...registrationTargetIdentityConditions(fence, true),
    eq(runners.activationGeneration, generation),
    reservationCondition(fence),
  ];
  return and(...conditions);
}

export function activeRegistrationTargetCondition(
  fence: RunnerRegistrationFence,
) {
  return and(...registrationTargetIdentityConditions(fence, false));
}

export function legacyRunnerTokenCondition(
  activeRunnerCondition: (filter: { readonly id: string }) => SQL | undefined,
  runnerId: string,
  tokenHash: string,
) {
  return and(
    activeRunnerCondition({ id: runnerId }),
    eq(runners.tokenDigest, ""),
    eq(runners.tokenHash, tokenHash),
  );
}

export function runnerIdSelection() {
  return { id: runners.id };
}

export function reservationCondition(fence: RunnerRegistrationFence) {
  return and(
    eq(runners.activationReservationId, fence.activationId),
    eq(runners.activationReservationGeneration, fence.generation),
    eq(runners.activationReservationSourceId, fence.sourceId),
  );
}

export function runnerReservationMatches(
  registration:
    | Pick<
        StoredRunnerRegistration,
        | "activationReservationGeneration"
        | "activationReservationId"
        | "activationReservationSourceId"
        | "userId"
      >
    | undefined,
  fence: RunnerRegistrationFence,
): boolean {
  return (
    registration?.userId === fence.userId &&
    registration.activationReservationId === fence.activationId &&
    registration.activationReservationGeneration === fence.generation &&
    registration.activationReservationSourceId === fence.sourceId
  );
}

export function runnerQuery<Select extends SelectedFields>(
  database: Pick<AppDatabase, "select">,
  selection: Select,
  condition: SQL | undefined,
) {
  return database.select(selection).from(runners).where(condition);
}

function storedRunner(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
  selection: ReturnType<typeof runnerRegistrationSelection>,
): StoredRunnerRegistration | undefined {
  return runnerQuery(database, selection, condition).get();
}

export function storedRunnerRegistration(
  database: Pick<AppDatabase, "select">,
  selection: {
    readonly [Key in keyof StoredRunnerRegistration]: (typeof runners)[Key];
  },
  condition: ReturnType<typeof and>,
): StoredRunnerRegistration | undefined {
  return storedRunner(database, condition, selection);
}

export function storedRunnerConnection(
  ...[database, condition]: Parameters<typeof storedRunnerId>
) {
  return database
    .select(runnerConnectionSelection())
    .from(runners)
    .where(condition)
    .get();
}

export function storedRunnerId(
  database: Pick<AppDatabase, "select">,
  condition: ReturnType<typeof and>,
) {
  return selectedString(
    database,
    { column: runners.id, table: runners },
    condition,
  );
}
