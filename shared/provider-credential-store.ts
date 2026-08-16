import { count, eq } from "drizzle-orm";
import { softDeletedAuditFields, updatedAuditFields } from "./audit.ts";
import {
  connectionIsAccessible,
  connectionWorkspaceIsAvailable,
  readConnectionScopes,
  removeConnectionScopes,
  replaceConnectionScopes,
  validateConnectionScopes,
  type ConnectionScopeConfiguration,
} from "./connection-scopes.ts";
import {
  fingerprintProviderCredential,
  type CredentialCipher,
} from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import {
  providerCredentials,
  providerCredentialWorkspaces,
} from "./database/schema.ts";
import { defaultValues } from "./default-store.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "./ids.ts";
import { validPageWindow } from "./pagination.ts";
import {
  accessibleCredentialIds,
  activeCredentialCondition,
  activeCredentialSummaries,
  credentialOrder,
  credentialScope,
  credentialSummarySelection,
  fingerprintCondition,
  legacyCredentialSummary,
  matchingCredentialId,
  modelCredentialCondition,
  ownedDefaultCondition,
  withEndpointFields,
  type ProviderCredentialPage,
} from "./provider-credential-store-query.ts";
import {
  isProviderId,
  MODEL_PROVIDER_IDS,
  type ProviderApiFormat,
  type ProviderId,
} from "./provider-id.ts";
import { GLOBAL_WORKSPACE_ID } from "./workspace-model.ts";

export { isProviderId, type ProviderApiFormat, type ProviderId };

export type ProviderCredentialSource = "api_key" | "oauth";
export type CredentialProviderId = ProviderId | "brave_search";

function encryptionContext(userId: string, credentialId: string): string {
  return `${userId}:${credentialId}`;
}

export interface ProviderCredentialDetails {
  readonly accountId: string | null;
  readonly apiFormat?: ProviderApiFormat;
  readonly baseUrl?: string;
  readonly label: string;
}

export interface ProviderCredentialSummary extends ProviderCredentialDetails {
  readonly id: string;
  readonly isDefault: boolean;
  readonly isGlobal?: boolean;
  readonly source: ProviderCredentialSource;
  readonly workspaceIds?: readonly string[];
}

export interface ProviderCredentialAccess extends ProviderCredentialSummary {
  readonly credentialFingerprint: string;
  readonly secret: string;
}

export class DuplicateProviderCredentialError extends Error {
  constructor() {
    super("This provider credential is already stored");
    this.name = "DuplicateProviderCredentialError";
  }
}

export class ProviderCredentialStore {
  readonly #cipher: CredentialCipher;
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator;
  readonly #provider: CredentialProviderId;
  readonly #scopeConfiguration: ConnectionScopeConfiguration;

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
    this.#scopeConfiguration = {
      associationTable: providerCredentialWorkspaces,
      generateId,
      ownerIdColumn: providerCredentialWorkspaces.providerCredentialId,
      ownerTable: providerCredentials,
    };
  }

  validateScopes(
    userId: string,
    workspaceIds: readonly string[],
  ): readonly string[] {
    return validateConnectionScopes(this.#database, userId, workspaceIds);
  }

  add(
    userId: string,
    credential: string,
    details: ProviderCredentialDetails,
    source: ProviderCredentialSource,
    now: number,
    workspaceIds: readonly string[] = [GLOBAL_WORKSPACE_ID],
  ): ProviderCredentialSummary {
    const fingerprint = fingerprintProviderCredential(credential, details);
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
    const normalizedScopes = this.validateScopes(userId, workspaceIds);
    const isGlobal = normalizedScopes.includes(GLOBAL_WORKSPACE_ID);
    const encryptedCredential = this.#cipher.seal(
      credential,
      encryptionContext(userId, id),
    );
    const timestamp = new Date(now);
    const mutableValues = {
      apiFormat: details.apiFormat ?? null,
      baseUrl: details.baseUrl ?? null,
      encryptedCredential,
      isDeleted: false,
      isDefault: false,
      isGlobal,
      label: details.label,
      providerAccountId: details.accountId,
      source,
      updatedAt: timestamp,
      updatedById: userId,
    };

    return this.#database.transaction((transaction) => {
      if (existing === undefined) {
        transaction
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
        transaction
          .update(providerCredentials)
          .set(mutableValues)
          .where(eq(providerCredentials.id, id))
          .run();
      }

      replaceConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        id,
        normalizedScopes,
        now,
      );
      return {
        ...details,
        id,
        isDefault: false,
        isGlobal,
        source,
        workspaceIds: normalizedScopes.filter(
          (workspaceId) => workspaceId !== GLOBAL_WORKSPACE_ID,
        ),
      };
    });
  }

  list(
    userId: string,
    workspaceId?: string,
  ): readonly ProviderCredentialSummary[] {
    return activeCredentialSummaries(
      this.#database,
      this.#provider,
      userId,
      workspaceId,
    ).map((credential) => ({
      ...credential,
      workspaceIds: this.#workspaceIds(userId, credential.id),
    }));
  }

  #workspaceIds(userId: string, credentialId: string): readonly string[] {
    return readConnectionScopes(
      this.#database,
      this.#scopeConfiguration,
      userId,
      credentialId,
    );
  }

  static listActiveModelCredentials(
    database: AppDatabase,
    userId: string,
    provider: ProviderId,
    workspaceId?: string,
  ): readonly ProviderCredentialSummary[] {
    return activeCredentialSummaries(database, provider, userId, workspaceId);
  }

  static hasActiveModelCredential(
    database: AppDatabase,
    userId: string,
    provider: ProviderId,
    credentialId: string,
    workspaceId?: string,
  ): boolean {
    return (
      matchingCredentialId(
        database,
        credentialScope(database, provider, userId, credentialId, workspaceId),
      ) !== undefined
    );
  }

  static listModelCredentials(
    database: AppDatabase,
    userId: string,
    ...[offset, limit, search, workspaceId]: [
      offset: number,
      limit: number,
      search?: string,
      workspaceId?: string,
    ]
  ): ProviderCredentialPage {
    if (!validPageWindow(offset, limit)) {
      throw new Error("The model credential page is invalid");
    }
    const accessibleIds =
      workspaceId === undefined
        ? undefined
        : MODEL_PROVIDER_IDS.flatMap((provider) =>
            accessibleCredentialIds(database, provider, userId, workspaceId),
          );
    const condition = modelCredentialCondition(userId, search, accessibleIds);
    const totalItems =
      database
        .select({ value: count() })
        .from(providerCredentials)
        .where(condition)
        .get()?.value ?? 0;
    const items = database
      .select({
        ...credentialSummarySelection(),
        provider: providerCredentials.provider,
      })
      .from(providerCredentials)
      .where(condition)
      .orderBy(...credentialOrder())
      .limit(limit)
      .offset(offset)
      .all()
      .flatMap((stored) =>
        isProviderId(stored.provider)
          ? [{ ...withEndpointFields(stored), provider: stored.provider }]
          : [],
      );
    return {
      items,
      totalItems,
    };
  }

  #readStored(userId: string, credentialId: string) {
    return this.#database.query.providerCredentials
      .findFirst({
        columns: {
          apiFormat: true,
          baseUrl: true,
          credentialFingerprint: true,
          encryptedCredential: true,
          id: true,
          label: true,
          providerAccountId: true,
          isDefault: true,
          isGlobal: true,
          source: true,
        },
        where: activeCredentialCondition(this.#provider, userId, credentialId),
      })
      .sync();
  }

  read(
    userId: string,
    ...[credentialId, workspaceId]: [credentialId: string, workspaceId?: string]
  ): ProviderCredentialAccess | undefined {
    const stored = this.#readStored(userId, credentialId);

    if (
      stored === undefined ||
      (workspaceId !== undefined &&
        !connectionWorkspaceIsAvailable(this.#database, userId, workspaceId)) ||
      !connectionIsAccessible(
        {
          isGlobal: stored.isGlobal,
          workspaceIds: this.#workspaceIds(userId, credentialId),
        },
        workspaceId,
      )
    ) {
      return undefined;
    }

    const summary: ProviderCredentialAccess = {
      accountId: stored.providerAccountId,
      ...(stored.apiFormat === null ? {} : { apiFormat: stored.apiFormat }),
      ...(stored.baseUrl === null ? {} : { baseUrl: stored.baseUrl }),
      credentialFingerprint: stored.credentialFingerprint,
      id: stored.id,
      isDefault: stored.isDefault,
      isGlobal: stored.isGlobal,
      label: stored.label,
      secret: this.#cipher.open(
        stored.encryptedCredential,
        encryptionContext(userId, credentialId),
      ),
      source: stored.source,
      workspaceIds: this.#workspaceIds(userId, credentialId),
    };
    return workspaceId === undefined
      ? {
          ...legacyCredentialSummary(summary),
          credentialFingerprint: summary.credentialFingerprint,
          secret: summary.secret,
        }
      : summary;
  }

  readSecret(
    userId: string,
    credentialId: string,
    workspaceId?: string,
  ): string | undefined {
    return this.read(userId, credentialId, workspaceId)?.secret;
  }

  setScopes(
    userId: string,
    credentialId: string,
    workspaceIds: readonly string[],
    now: number,
  ): boolean {
    const storedId = matchingCredentialId(
      this.#database,
      activeCredentialCondition(this.#provider, userId, credentialId),
    );
    if (storedId === undefined) {
      return false;
    }

    const normalizedScopes = this.validateScopes(userId, workspaceIds);
    return this.#database.transaction((transaction) => {
      transaction
        .update(providerCredentials)
        .set({
          isGlobal: normalizedScopes.includes(GLOBAL_WORKSPACE_ID),
          ...updatedAuditFields(userId, now),
        })
        .where(eq(providerCredentials.id, credentialId))
        .run();
      replaceConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        credentialId,
        normalizedScopes,
        now,
      );
      return true;
    });
  }

  setDefault(userId: string, credentialId: string, now: number): boolean {
    let changed = false;

    this.#database.transaction((transaction) => {
      const activeId = matchingCredentialId(
        transaction,
        activeCredentialCondition(this.#provider, userId, credentialId),
      );

      if (activeId === undefined) {
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
    const stored = this.#readStored(userId, credentialId);
    if (stored === undefined) {
      return false;
    }
    const updated = this.#database
      .update(providerCredentials)
      .set({
        credentialFingerprint: fingerprintProviderCredential(secret, stored),
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
    const storedId = matchingCredentialId(this.#database, condition);

    if (storedId === undefined) {
      return false;
    }

    this.#database.transaction((transaction) => {
      const scopeArguments = [
        transaction,
        this.#scopeConfiguration,
        userId,
        credentialId,
        now,
      ] as const;
      removeConnectionScopes(...scopeArguments);
      transaction
        .update(providerCredentials)
        .set({
          ...softDeletedAuditFields(userId, now),
          encryptedCredential: "",
          isDefault: false,
          isGlobal: false,
        })
        .where(condition)
        .run();
    });

    return true;
  }
}
