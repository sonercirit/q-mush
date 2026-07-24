import { and, asc, eq, not, type SQL } from "drizzle-orm";
import { softDeletedAuditFields, updatedAuditFields } from "./audit.ts";
import {
  fingerprintCredential,
  type CredentialCipher,
} from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import { providerCredentials } from "./database/schema.ts";
import { defaultValues } from "./default-store.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "./ids.ts";
import type { ProviderLimitState } from "./provider-limits.ts";

export type ProviderCredentialSource = "api_key" | "oauth";
export type ProviderId = "openai" | "openrouter";
export type CredentialProviderId = ProviderId | "brave_search";

export function isProviderId(value: unknown): value is ProviderId {
  return value === "openai" || value === "openrouter";
}

export interface ProviderCredentialDetails {
  readonly accountId: string | null;
  readonly label: string;
}

export interface ProviderCredentialSummary extends ProviderCredentialDetails {
  readonly id: string;
  readonly isDefault: boolean;
  readonly limits: ProviderLimitState;
  readonly source: ProviderCredentialSource;
}

export interface ProviderCredentialAccess extends Omit<
  ProviderCredentialSummary,
  "limits"
> {
  readonly secret: string;
}

export class DuplicateProviderCredentialError extends Error {
  constructor() {
    super("This provider credential is already stored");
    this.name = "DuplicateProviderCredentialError";
  }
}

function activeCredentialCondition(
  provider: CredentialProviderId,
  userId: string,
  credentialId?: string,
): SQL | undefined {
  return and(
    eq(providerCredentials.provider, provider),
    eq(providerCredentials.userId, userId),
    eq(providerCredentials.isDeleted, false),
    credentialId === undefined
      ? undefined
      : eq(providerCredentials.id, credentialId),
  );
}

function ownedDefaultCondition(
  userId: string,
  provider?: CredentialProviderId,
): SQL | undefined {
  const condition = and(
    eq(providerCredentials.userId, userId),
    not(providerCredentials.isDeleted),
    providerCredentials.isDefault,
  );
  return provider === undefined
    ? condition
    : and(condition, eq(providerCredentials.provider, provider));
}

function encryptionContext(userId: string, credentialId: string): string {
  return `${userId}:${credentialId}`;
}

function credentialSummarySelection() {
  return {
    accountId: providerCredentials.providerAccountId,
    id: providerCredentials.id,
    isDefault: providerCredentials.isDefault,
    label: providerCredentials.label,
    source: providerCredentials.source,
  };
}

function fingerprintCondition(
  provider: CredentialProviderId,
  userId: string,
  fingerprint: string,
): SQL | undefined {
  return and(
    eq(providerCredentials.credentialFingerprint, fingerprint),
    eq(providerCredentials.provider, provider),
    eq(providerCredentials.userId, userId),
  );
}

export class ProviderCredentialStore {
  readonly #cipher: CredentialCipher;
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator;
  readonly #provider: CredentialProviderId;

  constructor(
    database: AppDatabase,
    cipher: CredentialCipher,
    provider: CredentialProviderId,
    generateId: IdGenerator = createUuidV7,
  ) {
    this.#cipher = cipher;
    this.#database = database;
    this.#generateId = generateId;
    this.#provider = provider;
  }

  add(
    userId: string,
    credential: string,
    details: ProviderCredentialDetails,
    source: ProviderCredentialSource,
    now: number,
  ): ProviderCredentialSummary {
    const fingerprint = fingerprintCredential(credential);
    const existing = this.#database
      .select({
        id: providerCredentials.id,
        isDeleted: providerCredentials.isDeleted,
      })
      .from(providerCredentials)
      .where(fingerprintCondition(this.#provider, userId, fingerprint))
      .get();

    if (existing !== undefined && !existing.isDeleted) {
      throw new DuplicateProviderCredentialError();
    }

    const id = existing?.id ?? this.#generateId(now);
    const encryptedCredential = this.#cipher.seal(
      credential,
      encryptionContext(userId, id),
    );
    const timestamp = new Date(now);
    const mutableValues = {
      encryptedCredential,
      isDeleted: false,
      isDefault: false,
      label: details.label,
      providerAccountId: details.accountId,
      source,
      updatedAt: timestamp,
      updatedById: userId,
    };

    if (existing === undefined) {
      this.#database
        .insert(providerCredentials)
        .values({
          ...mutableValues,
          createdAt: timestamp,
          createdById: userId,
          credentialFingerprint: fingerprint,
          id,
          provider: this.#provider,
          userId,
        })
        .run();
    } else {
      this.#database
        .update(providerCredentials)
        .set(mutableValues)
        .where(eq(providerCredentials.id, id))
        .run();
    }

    return {
      ...details,
      id,
      isDefault: false,
      limits: { status: "unavailable" },
      source,
    };
  }

  list(userId: string): readonly ProviderCredentialSummary[] {
    const unavailableLimits: ProviderLimitState = { status: "unavailable" };
    return this.#database
      .select(credentialSummarySelection())
      .from(providerCredentials)
      .where(activeCredentialCondition(this.#provider, userId))
      .orderBy(asc(providerCredentials.createdAt), asc(providerCredentials.id))
      .all()
      .map((credential) => ({ ...credential, limits: unavailableLimits }));
  }

  #readStored(userId: string, credentialId: string) {
    return this.#database.query.providerCredentials
      .findFirst({
        columns: {
          encryptedCredential: true,
          id: true,
          label: true,
          providerAccountId: true,
          isDefault: true,
          source: true,
        },
        where: activeCredentialCondition(this.#provider, userId, credentialId),
      })
      .sync();
  }

  read(
    userId: string,
    credentialId: string,
  ): ProviderCredentialAccess | undefined {
    const stored = this.#readStored(userId, credentialId);

    if (stored === undefined) {
      return undefined;
    }

    return {
      accountId: stored.providerAccountId,
      id: stored.id,
      isDefault: stored.isDefault,
      label: stored.label,
      source: stored.source,
      secret: this.#cipher.open(
        stored.encryptedCredential,
        encryptionContext(userId, credentialId),
      ),
    };
  }

  readSecret(userId: string, credentialId: string): string | undefined {
    return this.read(userId, credentialId)?.secret;
  }

  setDefault(userId: string, credentialId: string, now: number): boolean {
    let changed = false;

    this.#database.transaction((transaction) => {
      const [credential] = transaction
        .select({ id: providerCredentials.id })
        .from(providerCredentials)
        .where(activeCredentialCondition(this.#provider, userId, credentialId))
        .all();

      if (credential === undefined) {
        return;
      }

      transaction
        .update(providerCredentials)
        .set(defaultValues(userId, now, false))
        .where(
          ownedDefaultCondition(
            userId,
            this.#provider === "brave_search" ? "brave_search" : undefined,
          ),
        )
        .run();
      transaction
        .update(providerCredentials)
        .set(defaultValues(userId, now, true))
        .where(eq(providerCredentials.id, credentialId))
        .run();
      changed = true;
    });

    return changed;
  }

  updateSecret(
    userId: string,
    credentialId: string,
    secret: string,
    now: number,
  ): boolean {
    const updated = this.#database
      .update(providerCredentials)
      .set({
        encryptedCredential: this.#cipher.seal(
          secret,
          encryptionContext(userId, credentialId),
        ),
        ...updatedAuditFields(SYSTEM_ID, now),
      })
      .where(activeCredentialCondition(this.#provider, userId, credentialId))
      .returning({ id: providerCredentials.id })
      .all();
    return updated.length > 0;
  }

  remove(userId: string, credentialId: string, now: number): boolean {
    const condition = activeCredentialCondition(
      this.#provider,
      userId,
      credentialId,
    );
    const stored = this.#database
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(condition)
      .get();

    if (stored === undefined) {
      return false;
    }

    this.#database
      .update(providerCredentials)
      .set({
        ...softDeletedAuditFields(userId, now),
        encryptedCredential: "",
        isDefault: false,
      })
      .where(condition)
      .run();

    return true;
  }
}
