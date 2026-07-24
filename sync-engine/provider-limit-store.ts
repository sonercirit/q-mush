import { and, asc, eq, not } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import {
  providerCredentials,
  providerLimitObservations,
} from "../shared/database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { readProviderLimitState } from "../shared/provider-limits-codec.ts";
import {
  providerLimitState,
  type ProviderLimitDimension,
  type ProviderLimitObservation,
  type ProviderLimitState,
} from "../shared/provider-limits.ts";

type ProviderLimitDatabase = Omit<AppDatabase, "$client">;

function activeOwnedCredential(userId: string, credentialId: string) {
  return and(
    not(providerCredentials.isDeleted),
    eq(providerCredentials.id, credentialId),
    eq(providerCredentials.userId, userId),
  );
}

function readDimensions(
  value: string,
): readonly ProviderLimitDimension[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const state = readProviderLimitState({
      dimensions: parsed,
      observedAt: 0,
      provider: "openai",
      source: "http_headers",
      stale: false,
      status: "available",
    });
    return state?.status === "available" && state.dimensions.length > 0
      ? state.dimensions
      : null;
  } catch {
    return null;
  }
}

function mergeDimension(
  current: ProviderLimitDimension | undefined,
  update: ProviderLimitDimension,
): ProviderLimitDimension {
  if (current === undefined) {
    return update;
  }
  return {
    ...update,
    limit: update.limit ?? current.limit,
    remaining: update.remaining ?? current.remaining,
    resetAt: update.resetAt ?? current.resetAt,
    ...("used" in update
      ? { used: update.used ?? current.used ?? null }
      : "used" in current
        ? { used: current.used }
        : {}),
  };
}

function mergeDimensions(
  current: readonly ProviderLimitDimension[],
  update: readonly ProviderLimitDimension[],
): readonly ProviderLimitDimension[] {
  const updates = new Map(
    update.map((dimension) => [dimension.key, dimension]),
  );
  const merged = current.map((dimension) => {
    const next = updates.get(dimension.key);
    if (next === undefined) {
      return dimension;
    }
    updates.delete(dimension.key);
    return mergeDimension(dimension, next);
  });
  return [...merged, ...updates.values()];
}

function safeObservation(
  observation: ProviderLimitObservation,
): ProviderLimitObservation | null {
  if (
    observation.dimensions.length === 0 ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < 0
  ) {
    return null;
  }

  const state = readProviderLimitState({
    ...observation,
    stale: false,
    status: "available",
  });
  return state?.status === "available"
    ? {
        dimensions: state.dimensions,
        observedAt: state.observedAt,
        provider: state.provider,
        source: state.source,
      }
    : null;
}

function canObserve(
  database: ProviderLimitDatabase,
  userId: string,
  credentialId: string,
  observation: ProviderLimitObservation,
): boolean {
  const credential = database
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(
      and(
        activeOwnedCredential(userId, credentialId),
        eq(providerCredentials.provider, observation.provider),
      ),
    )
    .get();
  return credential !== undefined;
}

function overlappingKeys(
  current: readonly ProviderLimitDimension[],
  update: readonly ProviderLimitDimension[],
): boolean {
  const currentKeys = new Set(current.map(({ key }) => key));
  return update.some(({ key }) => currentKeys.has(key));
}

function writeObservation(
  database: ProviderLimitDatabase,
  generateId: IdGenerator,
  userId: string,
  credentialId: string,
  observation: ProviderLimitObservation,
  now: number,
): boolean {
  const sanitized = safeObservation(observation);
  if (
    sanitized === null ||
    !canObserve(database, userId, credentialId, sanitized)
  ) {
    return false;
  }

  const existing = database
    .select()
    .from(providerLimitObservations)
    .where(eq(providerLimitObservations.credentialId, credentialId))
    .get();
  const existingDimensions =
    existing === undefined ? [] : (readDimensions(existing.dimensions) ?? []);
  if (
    existing !== undefined &&
    (existing.observedAt.getTime() > sanitized.observedAt ||
      (existing.observedAt.getTime() === sanitized.observedAt &&
        overlappingKeys(existingDimensions, sanitized.dimensions)))
  ) {
    return false;
  }

  const dimensions = mergeDimensions(existingDimensions, sanitized.dimensions);
  const timestamp = new Date(now);
  const values = {
    dimensions: JSON.stringify(dimensions),
    isDeleted: false,
    observedAt: new Date(sanitized.observedAt),
    provider: sanitized.provider,
    source: sanitized.source,
    updatedAt: timestamp,
    updatedById: SYSTEM_ID,
  } as const;

  if (existing === undefined) {
    database
      .insert(providerLimitObservations)
      .values({
        ...values,
        createdAt: timestamp,
        createdById: SYSTEM_ID,
        credentialId,
        id: generateId(now),
        userId,
      })
      .run();
  } else {
    database
      .update(providerLimitObservations)
      .set(values)
      .where(
        and(
          eq(providerLimitObservations.credentialId, credentialId),
          eq(providerLimitObservations.userId, userId),
          not(providerLimitObservations.isDeleted),
        ),
      )
      .run();
  }
  return true;
}

export interface OwnedProviderLimitState {
  readonly credentialId: string;
  readonly limits: ProviderLimitState;
}

export class ProviderLimitStore {
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator = createUuidV7;

  constructor(database: AppDatabase, generateId?: IdGenerator) {
    this.#database = database;
    if (generateId !== undefined) {
      this.#generateId = generateId;
    }
  }

  observe(
    owner: { readonly credentialId: string; readonly userId: string },
    observation: ProviderLimitObservation,
    now: number,
  ): boolean {
    // Validate, compare, and write under one reserved SQLite writer lock so
    // an older observation from another connection cannot overwrite this one.
    return this.#database.transaction(
      (transaction) =>
        writeObservation(
          transaction,
          this.#generateId,
          owner.userId,
          owner.credentialId,
          observation,
          now,
        ),
      { behavior: "immediate" },
    );
  }

  read(userId: string, credentialId: string, now: number): ProviderLimitState {
    const stored = this.#database
      .select({
        dimensions: providerLimitObservations.dimensions,
        observedAt: providerLimitObservations.observedAt,
        provider: providerLimitObservations.provider,
        source: providerLimitObservations.source,
      })
      .from(providerLimitObservations)
      .innerJoin(
        providerCredentials,
        eq(providerLimitObservations.credentialId, providerCredentials.id),
      )
      .where(
        and(
          activeOwnedCredential(userId, credentialId),
          eq(providerLimitObservations.userId, userId),
          eq(providerLimitObservations.isDeleted, false),
        ),
      )
      .get();

    const dimensions =
      stored === undefined ? null : readDimensions(stored.dimensions);
    return providerLimitState(
      stored === undefined || dimensions === null
        ? null
        : {
            dimensions,
            observedAt: stored.observedAt.getTime(),
            provider: stored.provider,
            source: stored.source,
          },
      now,
    );
  }

  list(userId: string, now: number): readonly OwnedProviderLimitState[] {
    const credentialIds = this.#database
      .select({ credentialId: providerCredentials.id })
      .from(providerCredentials)
      .innerJoin(
        providerLimitObservations,
        eq(providerCredentials.id, providerLimitObservations.credentialId),
      )
      .where(
        and(
          eq(providerLimitObservations.userId, userId),
          not(providerLimitObservations.isDeleted),
          eq(providerCredentials.userId, userId),
          not(providerCredentials.isDeleted),
        ),
      )
      .orderBy(asc(providerLimitObservations.createdAt))
      .all();
    return credentialIds.map(({ credentialId }) => ({
      credentialId,
      limits: this.read(userId, credentialId, now),
    }));
  }
}
