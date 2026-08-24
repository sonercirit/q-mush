import { and, eq, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { runners } from "../shared/database/schema.ts";
import { exactlyOneUpdatedRow } from "./database-update.ts";
import { applyFinalizedRunnerReservation } from "./runner-registration-application.ts";
import {
  durableActivationCondition,
  durableTargetCondition,
  finalizeRunnerRegistration,
  settleRunnerActivationLifecycle,
  touchFinalizedRunnerActivation,
} from "./runner-registration-finalization.ts";
import type { RunnerRegistrationOperations } from "./runner-registration-operations.ts";
import type {
  FinalizedRunnerActivationParameters,
  RunnerLifecycleParameters,
} from "./runner-registration-parameters.ts";
import {
  activeRegistrationTargetCondition,
  legacyRunnerTokenCondition,
  runnerQuery,
  runnerReservationMatches,
  storedRunnerId,
  storedRunnerRegistration,
} from "./runner-registration-query.ts";
import {
  activeMachineRunnerCondition,
  runnerMetadataMatches,
} from "./runner-registration-read.ts";
import {
  activationReceipt,
  receiptMatches,
} from "./runner-registration-receipt.ts";
import {
  createPreparedRegistration,
  createReservationValues,
  durableRegistrationFence,
  registrationSnapshotCondition,
} from "./runner-registration-scope.ts";
import type {
  RunnerActivationReceiptState,
  RunnerConnection,
  RunnerMetadata,
  RunnerRegistrationActivationResult,
  RunnerRegistrationCommitResult,
  RunnerRegistrationFence,
  RunnerRegistrationFinalizeOptions,
  RunnerRegistrationPreflight,
  RunnerRegistrationPreflightResult,
  RunnerRegistrationPrepareOptions,
  RunnerRegistrationResult,
  StoredRunnerRegistration,
} from "./runner-registration-types.ts";
import { createTokenDigest } from "./runner-token.ts";

export interface RunnerRegistrationStorePrimitives {
  activeRunnerCondition: (filter?: {
    id?: string;
    tokenHash?: string;
    userId?: string;
  }) => SQL | undefined;
  activeTokenCondition: (token: string) => SQL | undefined;
  runnerRegistrationSelection: () => RunnerRegistrationSelection;
  tokenHashMatches: (hash: string, token: string) => boolean;
}

type RunnerRegistrationSelection = {
  readonly [Key in keyof StoredRunnerRegistration]: (typeof runners)[Key];
};

export type RunnerRegistrationTransaction = Parameters<
  Parameters<AppDatabase["transaction"]>[0]
>[0];

interface RunnerRegistrationChangedError extends Error {
  readonly kind: "runner_registration_changed";
}

function createRunnerRegistrationChangedError(): RunnerRegistrationChangedError {
  return Object.assign(new Error("Runner registration changed"), {
    kind: "runner_registration_changed" as const,
  });
}

function isRunnerRegistrationChangedError(
  error: unknown,
): error is RunnerRegistrationChangedError {
  return (
    error instanceof Error &&
    "kind" in error &&
    error.kind === "runner_registration_changed"
  );
}

export interface RunnerRegistrationStoreContext extends RunnerRegistrationStorePrimitives {
  applyFinalizedReservation(
    transaction: RunnerRegistrationTransaction,
    source: StoredRunnerRegistration,
    now: number,
    touchOnly?: boolean,
  ): RunnerConnection | undefined;
  readonly database: AppDatabase;
  readonly durableFence: (
    registration: StoredRunnerRegistration,
  ) => RunnerRegistrationFence | undefined;
  readonly receiptMatches: (
    fence: RunnerRegistrationFence,
    receipt: string,
  ) => boolean;
}

export interface RunnerRegistrationStore extends RunnerRegistrationOperations {
  readonly database: AppDatabase;
}

export function createRunnerRegistrationStore(
  database: AppDatabase,
  primitives: RunnerRegistrationStorePrimitives,
  generateActivationId: () => string,
): RunnerRegistrationStore {
  const activeRunnerCondition = primitives.activeRunnerCondition;
  const activeTokenCondition = primitives.activeTokenCondition;
  const runnerRegistrationSelection = primitives.runnerRegistrationSelection;
  const tokenHashMatches = primitives.tokenHashMatches;
  const tokenDigestBackfilled = new Set<string>();
  function selectedRegistration(
    database: Pick<AppDatabase, "select">,
    condition: ReturnType<typeof and>,
  ): StoredRunnerRegistration | undefined {
    return storedRunnerRegistration(
      database,
      runnerRegistrationSelection(),
      condition,
    );
  }

  function tokenRegistration(
    token: string,
  ): StoredRunnerRegistration | undefined {
    const matching = runnerQuery(
      database,
      runnerRegistrationSelection(),
      activeTokenCondition(token),
    ).all();
    const stored = matching.length === 1 ? matching[0] : undefined;
    if (stored === undefined || !tokenHashMatches(stored.tokenHash, token)) {
      return undefined;
    }
    if (stored.tokenDigest !== "" || stored.activationPhase !== null) {
      return stored;
    }
    const digest = createTokenDigest(token);
    if (tokenDigestBackfilled.has(digest)) {
      return stored;
    }
    try {
      const backfilled = database
        .update(runners)
        .set({ tokenDigest: digest })
        .where(
          legacyRunnerTokenCondition(
            activeRunnerCondition,
            stored.id,
            stored.tokenHash,
          ),
        )
        .returning(runnerRegistrationSelection())
        .get();
      tokenDigestBackfilled.add(digest);
      return backfilled;
    } catch {
      return undefined;
    }
  }

  function activationSource(
    token: string,
  ): StoredRunnerRegistration | undefined {
    const registration = tokenRegistration(token);
    if (registration === undefined) {
      return undefined;
    }
    const sourceId = registration.activationSourceId;
    if (sourceId === null) {
      return registration;
    }
    return (
      selectedRegistration(database, eq(runners.id, sourceId)) ?? registration
    );
  }

  function preflight(
    token: string,
    metadata: RunnerMetadata,
    activationId?: string,
  ): RunnerRegistrationPreflightResult {
    const source = tokenRegistration(token);
    if (source === undefined) {
      return { status: "unknown_token" };
    }
    const recovered = createPreparedRegistration(source, metadata);
    if (recovered !== undefined) {
      const fence = durableRegistrationFence(source);
      if (fence === undefined) {
        return { status: "registration_changed" };
      }

      const target = selectedRegistration(
        database,
        activeRegistrationTargetCondition(fence),
      );
      if (target === undefined || !runnerReservationMatches(target, fence)) {
        return { status: "registration_changed" };
      }
      return {
        connection: { id: target.id, userId: source.userId },
        registration: { ...recovered, target },
        status: "ready",
      };
    }
    const sourceOwnsMachine =
      source.machineFingerprint === metadata.machineFingerprint;
    if (source.machineFingerprint !== null && !sourceOwnsMachine) {
      return { status: "token_already_used" };
    }
    const target = selectedRegistration(
      database,
      activeMachineRunnerCondition(metadata),
    );
    if (
      target !== undefined &&
      target.id !== source.id &&
      target.userId !== source.userId
    ) {
      return { status: "runner_exists" };
    }
    const registrationTarget = target ?? source;
    return {
      connection: { id: registrationTarget.id, userId: source.userId },
      registration: {
        activationId: activationId ?? generateActivationId(),
        metadata,
        source,
        target: registrationTarget,
        tokenDigest: source.tokenDigest,
      },
      status: "ready",
    };
  }

  function commit(
    preflight: RunnerRegistrationPreflight,
    options: RunnerRegistrationPrepareOptions,
  ): RunnerRegistrationCommitResult {
    if (
      (options.lifecycle === "ordinary" && options.restartId !== undefined) ||
      (options.lifecycle === "restart" && options.restartId === undefined)
    ) {
      return { status: "registration_changed" };
    }
    const existingFence = durableRegistrationFence(preflight.source);
    if (existingFence !== undefined) {
      const replaysSettledFinalization =
        existingFence.phase === "finalized" &&
        preflight.source.activationLifecycleSettled;
      return (replaysSettledFinalization ||
        (existingFence.lifecycle === options.lifecycle &&
          existingFence.restartId === options.restartId)) &&
        existingFence.activationId === preflight.activationId &&
        fenceIsCurrent(existingFence)
        ? {
            registration: {
              connection: {
                id: existingFence.targetId,
                userId: existingFence.userId,
              },
              fence: existingFence,
            },
            status: "registered",
          }
        : { status: "registration_changed" };
    }
    try {
      return database.transaction((transaction) => {
        const source = selectedRegistration(
          transaction,
          activeRunnerCondition({ id: preflight.source.id }),
        );
        const target =
          preflight.target.id === preflight.source.id
            ? source
            : selectedRegistration(
                transaction,
                activeRunnerCondition({ id: preflight.target.id }),
              );

        const currentComputer = transaction
          .select({ id: runners.id, userId: runners.userId })
          .from(runners)
          .where(
            and(
              eq(runners.isDeleted, false),
              eq(
                runners.machineFingerprint,
                preflight.metadata.machineFingerprint,
              ),
            ),
          )
          .get();
        if (
          source === undefined ||
          target === undefined ||
          source.activationGeneration !==
            preflight.source.activationGeneration ||
          target.activationGeneration !==
            preflight.target.activationGeneration ||
          source.tokenDigest !== preflight.tokenDigest ||
          source.tokenHash !== preflight.source.tokenHash ||
          source.machineFingerprint !== preflight.source.machineFingerprint ||
          source.activationId !== preflight.source.activationId ||
          source.activationPhase !== preflight.source.activationPhase ||
          source.activationLifecycleSettled !==
            preflight.source.activationLifecycleSettled ||
          target.machineFingerprint !== preflight.target.machineFingerprint ||
          target.activationId !== preflight.target.activationId ||
          target.activationPhase !== preflight.target.activationPhase ||
          target.activationLifecycleSettled !==
            preflight.target.activationLifecycleSettled ||
          target.userId !== source.userId ||
          (currentComputer !== undefined &&
            (currentComputer.id !== target.id ||
              currentComputer.userId !== source.userId))
        ) {
          throw createRunnerRegistrationChangedError();
        }
        const generation = source.activationGeneration + 1;
        const values = createReservationValues(preflight, options, generation);
        const prepared = transaction
          .update(runners)
          .set(values)
          .where(registrationSnapshotCondition(context(), source))
          .returning(runnerRegistrationSelection())
          .all();
        const persisted = prepared[0];
        if (prepared.length !== 1 || persisted === undefined) {
          throw createRunnerRegistrationChangedError();
        }
        if (target.id !== source.id) {
          const targetReserved = exactlyOneUpdatedRow(
            transaction,
            runners,
            {
              activationReservationGeneration: generation,
              activationReservationId: preflight.activationId,
              activationReservationSourceId: source.id,
            },
            registrationSnapshotCondition(context(), target),
            runners.id,
          );

          if (!targetReserved) {
            throw createRunnerRegistrationChangedError();
          }
        }
        const fence = durableRegistrationFence(persisted);
        if (fence?.generation !== generation) {
          throw createRunnerRegistrationChangedError();
        }
        return {
          registration: {
            connection: { id: target.id, userId: source.userId },
            fence,
          },
          status: "registered" as const,
        };
      });
    } catch (error) {
      if (isRunnerRegistrationChangedError(error)) {
        return { status: "registration_changed" };
      }
      throw error;
    }
  }

  function receipt(fence: RunnerRegistrationFence): string {
    return activationReceipt(fence);
  }

  function receiptState(
    token: string,
    metadata: RunnerMetadata,
    receipt: string,
  ): RunnerActivationReceiptState | undefined {
    const current = activationSource(token);
    const fence =
      current === undefined ? undefined : durableRegistrationFence(current);
    if (
      !runnerMetadataMatches(fence, metadata) ||
      fence === undefined ||
      !receiptMatches(fence, receipt)
    ) {
      return undefined;
    }
    const target = runnerQuery(
      database,
      {
        activationGeneration: runners.activationGeneration,
        activationId: runners.activationId,
        activationPhase: runners.activationPhase,
        activationReservationGeneration:
          runners.activationReservationGeneration,
        activationReservationId: runners.activationReservationId,
        activationReservationSourceId: runners.activationReservationSourceId,
        id: runners.id,
        userId: runners.userId,
      },
      activeRegistrationTargetCondition(fence),
    ).get();
    const targetActivationMatches =
      target !== undefined &&
      (fence.sourceId === fence.targetId || fence.phase === "finalized"
        ? target.activationId === fence.activationId &&
          target.activationPhase === fence.phase &&
          target.activationGeneration === fence.generation
        : target.activationGeneration === fence.targetGeneration);
    if (!targetActivationMatches || !runnerReservationMatches(target, fence)) {
      return undefined;
    }
    return {
      activationId: fence.activationId,
      connection: { id: fence.targetId, userId: fence.userId },
      lifecycle: fence.lifecycle,
      lifecycleSettled: current?.activationLifecycleSettled ?? false,
      phase: fence.phase,
      restartId: fence.restartId,
    };
  }

  function fenceIsCurrent(fence: RunnerRegistrationFence): boolean {
    return (
      storedRunnerId(database, durableActivationCondition(fence)) !==
        undefined &&
      storedRunnerId(database, durableTargetCondition(fence)) !== undefined
    );
  }

  function finalizeRegistration(
    fence: RunnerRegistrationFence,
    options: RunnerRegistrationFinalizeOptions,
  ): RunnerRegistrationActivationResult {
    return finalizeRunnerRegistration(context(), fence, options);
  }

  function settleActivationLifecycle(
    ...parameters: RunnerLifecycleParameters
  ): boolean {
    return settleRunnerActivationLifecycle(context(), ...parameters);
  }

  function touchFinalizedActivation(
    ...[token, metadata, receipt, now]: readonly [
      ...FinalizedRunnerActivationParameters,
      now: number,
    ]
  ): RunnerConnection | undefined {
    const source = activationSource(token);
    const fence =
      source === undefined ? undefined : durableRegistrationFence(source);
    return fence?.phase !== "finalized" ||
      !runnerMetadataMatches(source, metadata) ||
      !receiptMatches(fence, receipt)
      ? undefined
      : touchFinalizedRunnerActivation(context(), fence, now);
  }

  function register(
    token: string,
    metadata: RunnerMetadata,
    now: number,
  ): RunnerRegistrationResult {
    const registrationPreflight = preflight(token, metadata);
    if (registrationPreflight.status !== "ready") {
      return registrationPreflight;
    }
    const committed = commit(registrationPreflight.registration, {
      lifecycle: "ordinary",
      now,
    });
    if (committed.status !== "registered") {
      return committed;
    }
    const fence = committed.registration.fence;
    const activated = finalizeRegistration(fence, {
      now,
      receipt: receipt(fence),
    });
    return activated.status === "activated"
      ? { id: activated.connection.id, status: "registered" }
      : activated;
  }

  function context(): RunnerRegistrationStoreContext {
    return {
      activeRunnerCondition: activeRunnerCondition,
      activeTokenCondition: activeTokenCondition,
      applyFinalizedReservation: (transaction, source, now, touchOnly) =>
        applyFinalizedRunnerReservation(
          context(),
          transaction,
          source,
          now,
          touchOnly,
        ),
      database: database,
      durableFence: durableRegistrationFence,
      receiptMatches,
      runnerRegistrationSelection: runnerRegistrationSelection,
      tokenHashMatches: tokenHashMatches,
    };
  }

  return {
    commit,
    database,
    fenceIsCurrent,
    finalizeRegistration,
    preflight,
    receipt,
    receiptState,
    register,
    settleActivationLifecycle,
    touchFinalizedActivation,
  };
}
