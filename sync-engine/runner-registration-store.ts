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

class RunnerRegistrationChanged extends Error {}

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

export class RunnerRegistrationStore implements RunnerRegistrationOperations {
  readonly #activeRunnerCondition: RunnerRegistrationStorePrimitives["activeRunnerCondition"];
  readonly #activeTokenCondition: RunnerRegistrationStorePrimitives["activeTokenCondition"];
  readonly #generateActivationId: () => string;
  readonly #runnerRegistrationSelection: RunnerRegistrationStorePrimitives["runnerRegistrationSelection"];
  readonly #tokenHashMatches: RunnerRegistrationStorePrimitives["tokenHashMatches"];
  readonly #tokenDigestBackfilled = new Set<string>();

  constructor(
    readonly database: AppDatabase,
    primitives: RunnerRegistrationStorePrimitives,
    generateActivationId: () => string,
  ) {
    this.#activeRunnerCondition = primitives.activeRunnerCondition;
    this.#activeTokenCondition = primitives.activeTokenCondition;
    this.#generateActivationId = generateActivationId;
    this.#runnerRegistrationSelection = primitives.runnerRegistrationSelection;
    this.#tokenHashMatches = primitives.tokenHashMatches;
  }

  #selectedRegistration(
    database: Pick<AppDatabase, "select">,
    condition: ReturnType<typeof and>,
  ): StoredRunnerRegistration | undefined {
    return storedRunnerRegistration(
      database,
      this.#runnerRegistrationSelection(),
      condition,
    );
  }

  #tokenRegistration(token: string): StoredRunnerRegistration | undefined {
    const matching = runnerQuery(
      this.database,
      this.#runnerRegistrationSelection(),
      this.#activeTokenCondition(token),
    ).all();
    const stored = matching.length === 1 ? matching[0] : undefined;
    if (
      stored === undefined ||
      !this.#tokenHashMatches(stored.tokenHash, token)
    ) {
      return undefined;
    }
    if (stored.tokenDigest !== "" || stored.activationPhase !== null) {
      return stored;
    }
    const digest = createTokenDigest(token);
    if (this.#tokenDigestBackfilled.has(digest)) {
      return stored;
    }
    try {
      const backfilled = this.database
        .update(runners)
        .set({ tokenDigest: digest })
        .where(
          legacyRunnerTokenCondition(
            this.#activeRunnerCondition,
            stored.id,
            stored.tokenHash,
          ),
        )
        .returning(this.#runnerRegistrationSelection())
        .get();
      this.#tokenDigestBackfilled.add(digest);
      return backfilled;
    } catch {
      return undefined;
    }
  }

  #activationSource(token: string): StoredRunnerRegistration | undefined {
    const tokenRegistration = this.#tokenRegistration(token);
    if (tokenRegistration === undefined) {
      return undefined;
    }
    const sourceId = tokenRegistration.activationSourceId;
    if (sourceId === null) {
      return tokenRegistration;
    }
    return (
      this.#selectedRegistration(this.database, eq(runners.id, sourceId)) ??
      tokenRegistration
    );
  }

  preflight(
    token: string,
    metadata: RunnerMetadata,
    activationId?: string,
  ): RunnerRegistrationPreflightResult {
    const source = this.#tokenRegistration(token);
    if (source === undefined) {
      return { status: "unknown_token" };
    }
    const recovered = createPreparedRegistration(source, metadata);
    if (recovered !== undefined) {
      const fence = durableRegistrationFence(source);
      if (fence === undefined) {
        return { status: "registration_changed" };
      }

      const target = this.#selectedRegistration(
        this.database,
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
    const target = this.#selectedRegistration(
      this.database,
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
        activationId: activationId ?? this.#generateActivationId(),
        metadata,
        source,
        target: registrationTarget,
        tokenDigest: source.tokenDigest,
      },
      status: "ready",
    };
  }

  commit(
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
      return existingFence.activationId === preflight.activationId &&
        existingFence.lifecycle === options.lifecycle &&
        existingFence.restartId === options.restartId &&
        this.fenceIsCurrent(existingFence)
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
      return this.database.transaction((transaction) => {
        const source = this.#selectedRegistration(
          transaction,
          this.#activeRunnerCondition({ id: preflight.source.id }),
        );
        const target =
          preflight.target.id === preflight.source.id
            ? source
            : this.#selectedRegistration(
                transaction,
                this.#activeRunnerCondition({ id: preflight.target.id }),
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
          throw new RunnerRegistrationChanged();
        }
        const generation = source.activationGeneration + 1;
        const values = createReservationValues(preflight, options, generation);
        const prepared = transaction
          .update(runners)
          .set(values)
          .where(registrationSnapshotCondition(this.#context(), source))
          .returning(this.#runnerRegistrationSelection())
          .all();
        const persisted = prepared[0];
        if (prepared.length !== 1 || persisted === undefined) {
          throw new RunnerRegistrationChanged();
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
            registrationSnapshotCondition(this.#context(), target),
            runners.id,
          );

          if (!targetReserved) {
            throw new RunnerRegistrationChanged();
          }
        }
        const fence = durableRegistrationFence(persisted);
        if (fence?.generation !== generation) {
          throw new RunnerRegistrationChanged();
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
      if (error instanceof RunnerRegistrationChanged) {
        return { status: "registration_changed" };
      }
      throw error;
    }
  }

  receipt(fence: RunnerRegistrationFence): string {
    return activationReceipt(fence);
  }

  receiptState(
    token: string,
    metadata: RunnerMetadata,
    receipt: string,
  ): RunnerActivationReceiptState | undefined {
    const current = this.#activationSource(token);
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
      this.database,
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

  fenceIsCurrent(fence: RunnerRegistrationFence): boolean {
    return (
      storedRunnerId(this.database, durableActivationCondition(fence)) !==
        undefined &&
      storedRunnerId(this.database, durableTargetCondition(fence)) !== undefined
    );
  }

  finalizeRegistration(
    fence: RunnerRegistrationFence,
    options: RunnerRegistrationFinalizeOptions,
  ): RunnerRegistrationActivationResult {
    return finalizeRunnerRegistration(this.#context(), fence, options);
  }

  settleActivationLifecycle(...parameters: RunnerLifecycleParameters): boolean {
    return settleRunnerActivationLifecycle(this.#context(), ...parameters);
  }

  touchFinalizedActivation(
    ...[token, metadata, receipt, now]: readonly [
      ...FinalizedRunnerActivationParameters,
      now: number,
    ]
  ): RunnerConnection | undefined {
    const source = this.#activationSource(token);
    const fence =
      source === undefined ? undefined : durableRegistrationFence(source);
    return fence?.phase !== "finalized" ||
      !runnerMetadataMatches(source, metadata) ||
      !receiptMatches(fence, receipt)
      ? undefined
      : touchFinalizedRunnerActivation(this.#context(), fence, now);
  }

  register(
    token: string,
    metadata: RunnerMetadata,
    now: number,
  ): RunnerRegistrationResult {
    const preflight = this.preflight(token, metadata);
    if (preflight.status !== "ready") {
      return preflight;
    }
    const committed = this.commit(preflight.registration, {
      lifecycle: "ordinary",
      now,
    });
    if (committed.status !== "registered") {
      return committed;
    }
    const fence = committed.registration.fence;
    const activated = this.finalizeRegistration(fence, {
      now,
      receipt: this.receipt(fence),
    });
    return activated.status === "activated"
      ? { id: activated.connection.id, status: "registered" }
      : activated;
  }

  #context(): RunnerRegistrationStoreContext {
    return {
      activeRunnerCondition: this.#activeRunnerCondition,
      activeTokenCondition: this.#activeTokenCondition,
      applyFinalizedReservation: (transaction, source, now, touchOnly) =>
        applyFinalizedRunnerReservation(
          this.#context(),
          transaction,
          source,
          now,
          touchOnly,
        ),
      database: this.database,
      durableFence: durableRegistrationFence,
      receiptMatches,
      runnerRegistrationSelection: this.#runnerRegistrationSelection,
      tokenHashMatches: this.#tokenHashMatches,
    };
  }
}
