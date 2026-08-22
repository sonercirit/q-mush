import { and, eq, not, type SQL } from "drizzle-orm";
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
import type { CredentialCipher } from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import {
  providerCredentials,
  providerCredentialWorkspaces,
} from "./database/schema.ts";
import { defaultValues } from "./default-store.ts";
import { createUuidV7, type IdGenerator } from "./ids.ts";
import { ownedActiveCredentialCondition } from "./provider-credential-condition.ts";
import type {
  CredentialProviderId,
  ProviderCredentialAccess,
  ProviderCredentialDetails,
  ProviderCredentialPage,
  ProviderCredentialSource,
  ProviderCredentialSummary,
} from "./provider-credential-model.ts";
import {
  activeCredentialSummaries,
  modelCredentialIsActive,
  queryActiveModelCredentials,
  queryModelCredentials,
  type ModelCredentialQueryOptions,
} from "./provider-credential-query.ts";
import {
  markCredentialRequiresReauthentication,
  updateCredentialSecret,
} from "./provider-credential-reauthentication.ts";
import {
  decryptedCredentialValue,
  encryptedCredentialValue,
  presentProviderEndpointMetadata,
  storedCredentialFingerprint,
} from "./provider-credential-secret.ts";
import {
  isProviderId,
  type ProviderApiFormat,
  type ProviderId,
} from "./provider-id.ts";
import { GLOBAL_WORKSPACE_ID } from "./workspace-model.ts";

export {
  isProviderId,
  type ProviderApiFormat,
  type ProviderCredentialAccess,
  type ProviderCredentialDetails,
  type ProviderCredentialPage,
  type ProviderCredentialSource,
  type ProviderCredentialSummary,
  type ProviderId,
};

export class DuplicateProviderCredentialError extends Error {
  constructor() {
    super("This provider credential is already stored");
    this.name = "DuplicateProviderCredentialError";
  }
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

function matchingCredentialId(
  ...[database, condition]: readonly [
    database: Pick<AppDatabase, "select">,
    condition: SQL | undefined,
  ]
): string | undefined {
  const selection = database.select({ id: providerCredentials.id });
  return selection.from(providerCredentials).where(condition).get()?.id;
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

function legacyCredentialSummary(
  credential: ProviderCredentialSummary,
): ProviderCredentialSummary {
  return {
    accountId: credential.accountId,
    ...(credential.apiFormat === undefined
      ? {}
      : { apiFormat: credential.apiFormat }),
    ...(credential.baseUrl === undefined
      ? {}
      : { baseUrl: credential.baseUrl }),
    id: credential.id,
    isDefault: credential.isDefault,
    label: credential.label,
    source: credential.source,
  };
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
    const fingerprint = storedCredentialFingerprint({
      ...(details.apiFormat === undefined
        ? {}
        : { apiFormat: details.apiFormat }),
      ...(details.baseUrl === undefined ? {} : { baseUrl: details.baseUrl }),
      credential,
    });
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
    const encryptedCredential = encryptedCredentialValue({
      cipher: this.#cipher,
      credential,
      credentialId: id,
      userId,
    });
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
      requiresReauthentication: false,
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
        requiresReauthentication: false,
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
    ...selection: [provider: ProviderId, workspaceId?: string]
  ): readonly ProviderCredentialSummary[] {
    return queryActiveModelCredentials(database, userId, ...selection);
  }

  static hasActiveModelCredential(
    database: AppDatabase,
    userId: string,
    ...selection: [
      provider: ProviderId,
      credentialId: string,
      workspaceId?: string,
    ]
  ): boolean {
    return modelCredentialIsActive(database, userId, ...selection);
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
    const options: ModelCredentialQueryOptions = {
      pageSize: limit,
      skip: offset,
      ...(search === undefined ? {} : { search }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    };
    return queryModelCredentials(database, userId, options);
  }

  #readStored(userId: string, credentialId: string) {
    return this.#database.query.providerCredentials
      .findFirst({
        columns: {
          apiFormat: true,
          baseUrl: true,
          encryptedCredential: true,
          id: true,
          label: true,
          providerAccountId: true,
          isDefault: true,
          isGlobal: true,
          requiresReauthentication: true,
          source: true,
        },
        where: this.#activeCredentialCondition(userId, credentialId),
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
      ...presentProviderEndpointMetadata(stored),
      id: stored.id,
      isDefault: stored.isDefault,
      isGlobal: stored.isGlobal,
      label: stored.label,
      requiresReauthentication: stored.requiresReauthentication,
      secret: decryptedCredentialValue({
        cipher: this.#cipher,
        credentialId,
        encryptedCredential: stored.encryptedCredential,
        userId,
      }),
      source: stored.source,
      workspaceIds: this.#workspaceIds(userId, credentialId),
    };
    return workspaceId === undefined
      ? { ...legacyCredentialSummary(summary), secret: summary.secret }
      : summary;
  }

  readSecret(
    userId: string,
    credentialId: string,
    workspaceId?: string,
  ): string | undefined {
    return this.read(userId, credentialId, workspaceId)?.secret;
  }

  #activeCredentialCondition(userId: string, credentialId: string) {
    return ownedActiveCredentialCondition({
      credentialId,
      provider: this.#provider,
      userId,
    });
  }

  setScopes(
    userId: string,
    credentialId: string,
    workspaceIds: readonly string[],
    now: number,
  ): boolean {
    const storedId = matchingCredentialId(
      this.#database,
      this.#activeCredentialCondition(userId, credentialId),
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
        this.#activeCredentialCondition(userId, credentialId),
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

  markRequiresReauthentication(
    userId: string,
    credentialId: string,
    now: number,
  ): boolean {
    return markCredentialRequiresReauthentication(
      this.#credentialState(userId, credentialId, now),
    );
  }

  updateSecret(
    ...parameters: [
      userId: string,
      credentialId: string,
      secret: string,
      now: number,
      requireReauthentication?: boolean,
      accountId?: string,
      label?: string,
    ]
  ): boolean {
    const [
      userId,
      credentialId,
      secret,
      now,
      requireReauthentication,
      accountId,
      label,
    ] = parameters;
    return updateCredentialSecret({
      ...this.#credentialState(userId, credentialId, now),
      cipher: this.#cipher,
      secret,
      ...(requireReauthentication === undefined
        ? {}
        : { requireReauthentication }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(label === undefined ? {} : { label }),
    });
  }

  #credentialState(userId: string, credentialId: string, now: number) {
    return {
      credentialId,
      database: this.#database,
      now,
      provider: this.#provider,
      userId,
    };
  }

  remove(userId: string, credentialId: string, now: number): boolean {
    const condition = this.#activeCredentialCondition(userId, credentialId);
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
