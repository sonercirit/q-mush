import { and, asc, eq, type SQL } from "drizzle-orm";
import type { CredentialCipher } from "./credential-cipher.ts";
import { fingerprintCredential } from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import { openRouterCredentials } from "./database/schema.ts";
import { createUuidV7, type IdGenerator } from "./ids.ts";

export type OpenRouterCredentialSource = "api_key" | "oauth";

export interface OpenRouterCredentialDetails {
  readonly accountId: string | null;
  readonly label: string;
}

export interface OpenRouterCredentialSummary extends OpenRouterCredentialDetails {
  readonly id: string;
  readonly source: OpenRouterCredentialSource;
}

export class DuplicateOpenRouterCredentialError extends Error {
  constructor() {
    super("This OpenRouter credential is already stored");
    this.name = "DuplicateOpenRouterCredentialError";
  }
}

function activeCredentialCondition(
  userId: string,
  credentialId?: string,
): SQL | undefined {
  return and(
    eq(openRouterCredentials.userId, userId),
    eq(openRouterCredentials.isDeleted, false),
    credentialId === undefined
      ? undefined
      : eq(openRouterCredentials.id, credentialId),
  );
}

function encryptionContext(userId: string, credentialId: string): string {
  return `${userId}:${credentialId}`;
}

const fingerprintCondition = (
  userId: string,
  fingerprint: string,
): SQL | undefined =>
  and(
    eq(openRouterCredentials.apiKeyFingerprint, fingerprint),
    eq(openRouterCredentials.userId, userId),
  );

export class OpenRouterCredentialStore {
  readonly #cipher: CredentialCipher;
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator;

  constructor(
    database: AppDatabase,
    cipher: CredentialCipher,
    generateId: IdGenerator = createUuidV7,
  ) {
    this.#cipher = cipher;
    this.#database = database;
    this.#generateId = generateId;
  }

  add(
    userId: string,
    apiKey: string,
    details: OpenRouterCredentialDetails,
    source: OpenRouterCredentialSource,
    now: number,
  ): OpenRouterCredentialSummary {
    const fingerprint = fingerprintCredential(apiKey);
    const existing = this.#database
      .select({
        id: openRouterCredentials.id,
        isDeleted: openRouterCredentials.isDeleted,
      })
      .from(openRouterCredentials)
      .where(fingerprintCondition(userId, fingerprint))
      .get();

    if (existing !== undefined && !existing.isDeleted) {
      throw new DuplicateOpenRouterCredentialError();
    }

    const id = existing?.id ?? this.#generateId(now);
    const encryptedApiKey = this.#cipher.seal(
      apiKey,
      encryptionContext(userId, id),
    );
    const timestamp = new Date(now);
    const mutableValues = {
      encryptedApiKey,
      isDeleted: false,
      label: details.label,
      openRouterUserId: details.accountId,
      source,
      updatedAt: timestamp,
      updatedById: userId,
    };

    if (existing === undefined) {
      this.#database
        .insert(openRouterCredentials)
        .values({
          ...mutableValues,
          apiKeyFingerprint: fingerprint,
          createdAt: timestamp,
          createdById: userId,
          id,
          userId,
        })
        .run();
    } else {
      this.#database
        .update(openRouterCredentials)
        .set(mutableValues)
        .where(eq(openRouterCredentials.id, id))
        .run();
    }

    return { ...details, id, source };
  }

  list(userId: string): readonly OpenRouterCredentialSummary[] {
    return this.#database
      .select({
        accountId: openRouterCredentials.openRouterUserId,
        id: openRouterCredentials.id,
        label: openRouterCredentials.label,
        source: openRouterCredentials.source,
      })
      .from(openRouterCredentials)
      .where(activeCredentialCondition(userId))
      .orderBy(
        asc(openRouterCredentials.createdAt),
        asc(openRouterCredentials.id),
      )
      .all();
  }

  readApiKey(userId: string, credentialId: string): string | undefined {
    const credential = this.#database
      .select({ encryptedApiKey: openRouterCredentials.encryptedApiKey })
      .from(openRouterCredentials)
      .where(activeCredentialCondition(userId, credentialId))
      .get();

    return credential === undefined
      ? undefined
      : this.#cipher.open(
          credential.encryptedApiKey,
          encryptionContext(userId, credentialId),
        );
  }

  remove(userId: string, credentialId: string, now: number): boolean {
    const condition = activeCredentialCondition(userId, credentialId);
    const credential = this.#database
      .select({ id: openRouterCredentials.id })
      .from(openRouterCredentials)
      .where(condition)
      .get();

    if (credential === undefined) {
      return false;
    }

    this.#database
      .update(openRouterCredentials)
      .set({
        encryptedApiKey: "",
        isDeleted: true,
        updatedAt: new Date(now),
        updatedById: userId,
      })
      .where(condition)
      .run();

    return true;
  }
}
