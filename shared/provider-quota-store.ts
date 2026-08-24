import { and, eq, isNull, lte } from "drizzle-orm";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "./audit.ts";
import type { AppDatabase } from "./database.ts";
import {
  providerQuotaResetReceipts,
  providerQuotaSettings,
} from "./database/schema.ts";
import { createUuidV7, type IdGenerator } from "./ids.ts";
import {
  DEFAULT_AUTO_RESET_THRESHOLD_PERCENT,
  type ProviderQuotaResetOutcome,
} from "./provider-quota.ts";
import { createStoreResources } from "./store-resources.ts";

export interface ProviderQuotaSetting {
  readonly autoResetThresholdPercent: number;
}

const PROVIDER_QUOTA_RESET_LEASE_MILLISECONDS = 60_000;

export type ResetReservation =
  | {
      readonly leaseAcquiredAt: number;
      readonly providerRequestId: string;
      readonly replayedResult?: never;
      readonly reserved: true;
    }
  | {
      readonly providerRequestId?: never;
      readonly replayedResult?: ProviderQuotaResetOutcome;
      readonly reserved: false;
    };

function quotaSettingCondition(userId: string, credentialId: string) {
  return and(
    eq(providerQuotaSettings.userId, userId),
    eq(providerQuotaSettings.providerCredentialId, credentialId),
    eq(providerQuotaSettings.isDeleted, false),
  );
}

type QuotaTransaction = Parameters<
  Parameters<AppDatabase["transaction"]>[0]
>[0];
type QuotaDatabase = AppDatabase | QuotaTransaction;

function activeReceiptCondition(userId: string, credentialId: string) {
  return and(
    eq(providerQuotaResetReceipts.userId, userId),
    eq(providerQuotaResetReceipts.providerCredentialId, credentialId),
    eq(providerQuotaResetReceipts.isDeleted, false),
  );
}

function receiptCondition(
  userId: string,
  credentialId: string,
  requestId: string,
) {
  return and(
    activeReceiptCondition(userId, credentialId),
    eq(providerQuotaResetReceipts.clientRequestId, requestId),
  );
}

function leasedReceiptCondition(
  userId: string,
  credentialId: string,
  requestId: string,
  leaseAcquiredAt: number,
) {
  return and(
    receiptCondition(userId, credentialId, requestId),
    eq(providerQuotaResetReceipts.updatedAt, new Date(leaseAcquiredAt)),
    isNull(providerQuotaResetReceipts.outcome),
  );
}

function mutateLeasedReceipt(
  database: QuotaDatabase,
  userId: string,
  credentialId: string,
  requestId: string,
  leaseAcquiredAt: number,
  values: Partial<typeof providerQuotaResetReceipts.$inferInsert>,
): boolean {
  const changed = database
    .update(providerQuotaResetReceipts)
    .set(values)
    .where(
      leasedReceiptCondition(userId, credentialId, requestId, leaseAcquiredAt),
    )
    .returning(changedReceiptId())
    .all();
  return changed.length > 0;
}

function pendingReceiptCondition(userId: string, credentialId: string) {
  return and(
    activeReceiptCondition(userId, credentialId),
    isNull(providerQuotaResetReceipts.outcome),
  );
}

function changedReceiptId() {
  return { id: providerQuotaResetReceipts.id };
}

function settingValues(
  id: string,
  userId: string,
  threshold: number,
  timestamp: Date,
) {
  return {
    ...createdAuditFields(userId, timestamp.getTime()),
    autoResetThresholdPercent: threshold,
    id,
    providerCredentialId: id,
    userId,
  };
}

export type ProviderQuotaResetCompleter = (
  userId: string,
  credentialId: string,
  requestId: string,
  result: ProviderQuotaResetOutcome,
  now: number,
  replayRequestId?: string,
  leaseAcquiredAt?: number,
) => void;

export interface ProviderQuotaStore {
  readonly read: (userId: string, credentialId: string) => ProviderQuotaSetting;
  readonly setThreshold: (
    userId: string,
    credentialId: string,
    threshold: number,
    now: number,
  ) => void;
  readonly reserveReset: (
    userId: string,
    credentialId: string,
    requestId: string,
    now: number,
  ) => ResetReservation;
  readonly completeReset: ProviderQuotaResetCompleter;
  readonly releaseReset: (
    userId: string,
    credentialId: string,
    requestId: string,
    now: number,
    leaseAcquiredAt?: number,
  ) => void;
}

export function createProviderQuotaStore(
  database: AppDatabase,
  generateId: IdGenerator = createUuidV7,
): ProviderQuotaStore {
  const resources = createStoreResources(database, generateId);
  const storeDatabase = resources.database;
  const idAt = resources.generateId;

  function read(userId: string, credentialId: string): ProviderQuotaSetting {
    return (
      storeDatabase
        .select({
          autoResetThresholdPercent:
            providerQuotaSettings.autoResetThresholdPercent,
        })
        .from(providerQuotaSettings)
        .where(quotaSettingCondition(userId, credentialId))
        .get() ?? {
        autoResetThresholdPercent: DEFAULT_AUTO_RESET_THRESHOLD_PERCENT,
      }
    );
  }

  function setThreshold(
    userId: string,
    credentialId: string,
    threshold: number,
    now: number,
  ): void {
    const updated = storeDatabase
      .update(providerQuotaSettings)
      .set({
        ...updatedAuditFields(userId, now),
        autoResetThresholdPercent: threshold,
      })
      .where(quotaSettingCondition(userId, credentialId))
      .returning({ id: providerQuotaSettings.id })
      .all();
    if (updated.length === 0) {
      storeDatabase
        .insert(providerQuotaSettings)
        .values({
          ...settingValues(idAt(now), userId, threshold, new Date(now)),
          providerCredentialId: credentialId,
        })
        .run();
    }
  }

  function reclaimReset(
    userId: string,
    credentialId: string,
    providerRequestId: string,
    now: number,
  ): ResetReservation {
    const reclaimed = storeDatabase
      .update(providerQuotaResetReceipts)
      .set(updatedAuditFields(userId, now))
      .where(
        and(
          receiptCondition(userId, credentialId, providerRequestId),
          isNull(providerQuotaResetReceipts.outcome),
          lte(
            providerQuotaResetReceipts.updatedAt,
            new Date(now - PROVIDER_QUOTA_RESET_LEASE_MILLISECONDS),
          ),
        ),
      )
      .returning(changedReceiptId())
      .all();
    return reclaimed.length === 0
      ? { reserved: false }
      : { leaseAcquiredAt: now, providerRequestId, reserved: true };
  }

  function reserveReset(
    userId: string,
    credentialId: string,
    requestId: string,
    now: number,
  ): ResetReservation {
    const existing = storeDatabase
      .select({
        clientRequestId: providerQuotaResetReceipts.clientRequestId,
        outcome: providerQuotaResetReceipts.outcome,
      })
      .from(providerQuotaResetReceipts)
      .where(receiptCondition(userId, credentialId, requestId))
      .get();
    if (existing !== undefined) {
      return existing.outcome === null
        ? reclaimReset(userId, credentialId, existing.clientRequestId, now)
        : { replayedResult: existing.outcome, reserved: false };
    }
    const pending = storeDatabase
      .select({ clientRequestId: providerQuotaResetReceipts.clientRequestId })
      .from(providerQuotaResetReceipts)
      .where(pendingReceiptCondition(userId, credentialId))
      .get();
    if (pending !== undefined) {
      return reclaimReset(userId, credentialId, pending.clientRequestId, now);
    }
    try {
      storeDatabase
        .insert(providerQuotaResetReceipts)
        .values({
          ...createdAuditFields(userId, now),
          clientRequestId: requestId,
          id: idAt(now),
          providerCredentialId: credentialId,
          userId,
        })
        .run();
      return {
        leaseAcquiredAt: now,
        providerRequestId: requestId,
        reserved: true,
      };
    } catch {
      return { reserved: false };
    }
  }

  const completeReset: ProviderQuotaResetCompleter = (
    userId,
    credentialId,
    requestId,
    result,
    now,
    replayRequestId = requestId,
    leaseAcquiredAt = now,
  ) => {
    const timestamp = new Date(now);
    storeDatabase.transaction((transaction) => {
      const completed = mutateLeasedReceipt(
        transaction,
        userId,
        credentialId,
        requestId,
        leaseAcquiredAt,
        {
          completedAt: timestamp,
          outcome: result,
          ...updatedAuditFields(userId, now),
        },
      );
      if (completed && replayRequestId !== requestId) {
        transaction
          .insert(providerQuotaResetReceipts)
          .values({
            ...createdAuditFields(userId, now),
            clientRequestId: replayRequestId,
            completedAt: timestamp,
            id: idAt(now),
            outcome: result,
            providerCredentialId: credentialId,
            userId,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  };

  function releaseReset(
    userId: string,
    credentialId: string,
    requestId: string,
    now: number,
    leaseAcquiredAt = now,
  ): void {
    mutateLeasedReceipt(
      storeDatabase,
      userId,
      credentialId,
      requestId,
      leaseAcquiredAt,
      softDeletedAuditFields(userId, now),
    );
  }

  return { completeReset, read, releaseReset, reserveReset, setThreshold };
}
