import { and, asc, eq, type SQL } from "drizzle-orm";
import { softDeletedAuditFields, updatedAuditFields } from "./audit.ts";
import {
  fingerprintCredential,
  type CredentialCipher,
} from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import { providerCredentials } from "./database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "./ids.ts";

export type ProviderCredentialSource = "api_key" | "oauth";
export type ProviderId = "openai" | "openrouter";
export type CredentialProviderId = ProviderId | "brave_search";

export interface ProviderCredentialDetails {
  readonly accountId: string | null;
  readonly label: string;
}

export interface ProviderCredentialSummary extends ProviderCredentialDetails {
  readonly id: string;
  readonly source: ProviderCredentialSource;
}

export interface ProviderCredentialAccess extends ProviderCredentialSummary {
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

function encryptionContext(userId: string, credentialId: string): string {
  return `${userId}:${credentialId}`;
}

function credentialSummarySelection() {
  return {
    accountId: providerCredentials.providerAccountId,
    id: providerCredentials.id,
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

    return { ...details, id, source };
  }

  list(userId: string): readonly ProviderCredentialSummary[] {
    return this.#database
      .select(credentialSummarySelection())
      .from(providerCredentials)
      .where(activeCredentialCondition(this.#provider, userId))
      .orderBy(asc(providerCredentials.createdAt), asc(providerCredentials.id))
      .all();
  }

  read(
    userId: string,
    credentialId: string,
  ): ProviderCredentialAccess | undefined {
    const stored = this.#database
      .select({
        ...credentialSummarySelection(),
        encryptedCredential: providerCredentials.encryptedCredential,
      })
      .from(providerCredentials)
      .where(activeCredentialCondition(this.#provider, userId, credentialId))
      .get();

    if (stored === undefined) {
      return undefined;
    }

    const { encryptedCredential, ...summary } = stored;
    return {
      ...summary,
      secret: this.#cipher.open(
        encryptedCredential,
        encryptionContext(userId, credentialId),
      ),
    };
  }

  readSecret(userId: string, credentialId: string): string | undefined {
    return this.read(userId, credentialId)?.secret;
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
      })
      .where(condition)
      .run();

    return true;
  }
}
