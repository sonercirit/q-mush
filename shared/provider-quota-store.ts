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

export class ProviderQuotaStore {
  readonly #database: AppDatabase;
  readonly #idAt: (now: number) => string;

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    const resources = createStoreResources(database, generateId);
    this.#database = resources.database;
    this.#idAt = resources.generateId;
  }

  read(userId: string, credentialId: string): ProviderQuotaSetting {
    return (
      this.#database
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

  setThreshold(
    userId: string,
    credentialId: string,
    threshold: number,
    now: number,
  ): void {
    const updated = this.#database
      .update(providerQuotaSettings)
      .set({
        ...updatedAuditFields(userId, now),
        autoResetThresholdPercent: threshold,
      })
      .where(quotaSettingCondition(userId, credentialId))
      .returning({ id: providerQuotaSettings.id })
      .all();
    if (updated.length === 0) {
      this.#database
        .insert(providerQuotaSettings)
        .values({
          ...settingValues(this.#idAt(now), userId, threshold, new Date(now)),
          providerCredentialId: credentialId,
        })
        .run();
    }
  }

  #reclaimReset(
    userId: string,
    credentialId: string,
    providerRequestId: string,
    now: number,
  ): ResetReservation {
    const reclaimed = this.#database
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

  reserveReset(
    userId: string,
    credentialId: string,
    requestId: string,
    now: number,
  ): ResetReservation {
    const existing = this.#database
      .select({
        clientRequestId: providerQuotaResetReceipts.clientRequestId,
        outcome: providerQuotaResetReceipts.outcome,
      })
      .from(providerQuotaResetReceipts)
      .where(receiptCondition(userId, credentialId, requestId))
      .get();
    if (existing !== undefined) {
      return existing.outcome === null
        ? this.#reclaimReset(
            userId,
            credentialId,
            existing.clientRequestId,
            now,
          )
        : { replayedResult: existing.outcome, reserved: false };
    }
    const pending = this.#database
      .select({ clientRequestId: providerQuotaResetReceipts.clientRequestId })
      .from(providerQuotaResetReceipts)
      .where(pendingReceiptCondition(userId, credentialId))
      .get();
    if (pending !== undefined) {
      return this.#reclaimReset(
        userId,
        credentialId,
        pending.clientRequestId,
        now,
      );
    }
    try {
      this.#database
        .insert(providerQuotaResetReceipts)
        .values({
          ...createdAuditFields(userId, now),
          clientRequestId: requestId,
          id: this.#idAt(now),
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

  completeReset(
    userId: string,
    credentialId: string,
    requestId: string,
    result: ProviderQuotaResetOutcome,
    now: number,
    replayRequestId = requestId,
    leaseAcquiredAt = now,
  ): void {
    const timestamp = new Date(now);
    this.#database.transaction((transaction) => {
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
            id: this.#idAt(now),
            outcome: result,
            providerCredentialId: credentialId,
            userId,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  releaseReset(
    userId: string,
    credentialId: string,
    requestId: string,
    now: number,
    leaseAcquiredAt = now,
  ): void {
    mutateLeasedReceipt(
      this.#database,
      userId,
      credentialId,
      requestId,
      leaseAcquiredAt,
      softDeletedAuditFields(userId, now),
    );
  }
}
