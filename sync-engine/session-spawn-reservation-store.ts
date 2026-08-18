import { and, eq } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { IdGenerator } from "../shared/ids.ts";
import {
  sessionExecutionIsCurrent,
  type SessionExecutionAuthority,
} from "./session-execution-authority.ts";
import type { SessionRequestModelMetadata } from "./session-provider-selection.ts";
import { settleSessionFailure } from "./session-restart-failure-store.ts";
import { storedSessionCondition } from "./session-store-persistence.ts";
import { serializeProviderPricing } from "./session-store-read.ts";

export type SpawnedSessionMetadata = SessionRequestModelMetadata & {
  readonly credentialId: string;
};

interface SpawnedSessionReservationIdentity {
  readonly generation: number;
  readonly sessionId: string;
  readonly userId: string;
}

interface AuthorizedReservationOptions {
  readonly authority: SessionExecutionAuthority;
  readonly identity: SpawnedSessionReservationIdentity;
}

function reservationCondition(
  identity: SpawnedSessionReservationIdentity,
  pendingOnly: boolean,
) {
  return and(
    storedSessionCondition({
      generation: identity.generation,
      id: identity.sessionId,
      status: "queued",
      userId: identity.userId,
    }),
    pendingOnly ? eq(agentSessions.spawnPreparationPending, true) : undefined,
  );
}

function parentExecutionIsCurrent(
  database: Pick<AppDatabase, "select">,
  options: AuthorizedReservationOptions,
): boolean {
  return sessionExecutionIsCurrent(
    database,
    options.authority,
    options.identity.userId,
  );
}

function updateReservation(
  database: Pick<AppDatabase, "update">,
  identity: SpawnedSessionReservationIdentity,
  values: Partial<typeof agentSessions.$inferInsert>,
): boolean {
  const updated = database
    .update(agentSessions)
    .set(values)
    .where(reservationCondition(identity, true))
    .returning({ id: agentSessions.id })
    .all();
  return updated.length === 1;
}

export function claimSpawnedSessionReservation(options: {
  readonly authority: SessionExecutionAuthority;
  readonly database: AppDatabase;
  readonly identity: SpawnedSessionReservationIdentity;
}): boolean {
  return options.database.transaction((transaction) =>
    parentExecutionIsCurrent(transaction, options)
      ? updateReservation(transaction, options.identity, {
          spawnPreparationPending: false,
        })
      : false,
  );
}

type SpawnReservationRecoveryOptions = Pick<
  Parameters<typeof failSpawnedSessionReservation>[0],
  "content" | "database" | "generateId" | "now"
>;

export function recoverSpawnedSessionReservations(
  options: SpawnReservationRecoveryOptions,
): number {
  const reservations = options.database
    .select({
      generation: agentSessions.executionGeneration,
      sessionId: agentSessions.id,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.spawnPreparationPending, true),
        storedSessionCondition({ status: "queued" }),
      ),
    )
    .all();
  return reservations.reduce(
    (count, identity) =>
      count +
      Number(
        failSpawnedSessionReservation({
          ...options,
          identity,
        }),
      ),
    0,
  );
}

export function failSpawnedSessionReservation(options: {
  readonly allowClaimed?: boolean;
  readonly content: string;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly identity: SpawnedSessionReservationIdentity;
  readonly now: number;
}): boolean {
  return options.database.transaction((transaction) => {
    const condition = reservationCondition(
      options.identity,
      options.allowClaimed !== true,
    );
    if (
      !settleSessionFailure(
        {
          condition,
          database: transaction,
          generateId: options.generateId,
          generation: options.identity.generation,
          now: options.now,
          sessionId: options.identity.sessionId,
          userId: options.identity.userId,
        },
        options.content,
      )
    ) {
      return false;
    }
    transaction
      .update(agentSessions)
      .set({ spawnPreparationPending: false })
      .where(
        storedSessionCondition({
          generation: options.identity.generation,
          id: options.identity.sessionId,
          status: "failed",
          userId: options.identity.userId,
        }),
      )
      .run();
    return true;
  });
}

export function prepareSpawnedSessionReservation(options: {
  readonly authority: SessionExecutionAuthority;
  readonly database: AppDatabase;
  readonly identity: SpawnedSessionReservationIdentity;
  readonly metadata: SpawnedSessionMetadata;
  readonly now: number;
}): "parent_stale" | "prepared" {
  return options.database.transaction((transaction) => {
    if (!parentExecutionIsCurrent(transaction, options)) {
      return "parent_stale";
    }
    return updateReservation(transaction, options.identity, {
      adaptiveThinking: options.metadata.adaptiveThinking,
      maxContextTokens: options.metadata.maxContextTokens,
      maxOutputTokens: options.metadata.maxOutputTokens,
      providerCredentialId: options.metadata.credentialId,
      providerPricing: serializeProviderPricing(
        options.metadata.providerPricing,
      ),
      ...updatedAuditFields(options.identity.userId, options.now),
    })
      ? "prepared"
      : "parent_stale";
  });
}
