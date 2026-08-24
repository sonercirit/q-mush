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

function isCredentialFingerprintCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "provider_credentials.user_id, provider_credentials.provider, provider_credentials.credential_fingerprint",
    )
  );
}

const DUPLICATE_PROVIDER_CREDENTIAL_ERROR =
  "DuplicateProviderCredentialError" as const;

export interface DuplicateProviderCredentialError extends Error {
  readonly name: typeof DUPLICATE_PROVIDER_CREDENTIAL_ERROR;
}

const createDuplicateProviderCredentialError =
  (): DuplicateProviderCredentialError =>
    Object.assign(new Error("This provider credential is already stored"), {
      name: DUPLICATE_PROVIDER_CREDENTIAL_ERROR,
    });

export const isDuplicateProviderCredentialError = (
  value: unknown,
): value is DuplicateProviderCredentialError =>
  value instanceof Error && value.name === DUPLICATE_PROVIDER_CREDENTIAL_ERROR;

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

export const listActiveModelCredentials = queryActiveModelCredentials;
export const hasActiveModelCredential = modelCredentialIsActive;
export function listModelCredentials(
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

export type ReadProviderCredential = (
  userId: string,
  credentialId: string,
  workspaceId?: string,
) => ProviderCredentialAccess | undefined;

type AddCredentialArguments = [
  userId: string,
  credential: string,
  details: ProviderCredentialDetails,
  source: ProviderCredentialSource,
  now: number,
  workspaceIds?: readonly string[],
];
type SetScopesArguments = [
  userId: string,
  credentialId: string,
  workspaceIds: readonly string[],
  now: number,
];
type UpdateSecretArguments = [
  userId: string,
  credentialId: string,
  secret: string,
  now: number,
  requireReauthentication?: boolean,
  accountId?: string,
  label?: string,
];

type ReadSecret = (
  userId: string,
  credentialId: string,
  workspaceId?: string,
) => string | undefined;

export interface ProviderCredentialStore {
  validateScopes(
    userId: string,
    workspaceIds: readonly string[],
  ): readonly string[];
  add(...parameters: AddCredentialArguments): ProviderCredentialSummary;
  list(
    userId: string,
    workspaceId?: string,
  ): readonly ProviderCredentialSummary[];
  read: ReadProviderCredential;
  readSecret: ReadSecret;
  setScopes(...parameters: SetScopesArguments): boolean;
  setDefault(userId: string, credentialId: string, now: number): boolean;
  markRequiresReauthentication(
    userId: string,
    credentialId: string,
    now: number,
  ): boolean;
  updateSecret(...parameters: UpdateSecretArguments): boolean;
  remove(userId: string, credentialId: string, now: number): boolean;
}

export function createProviderCredentialStore(
  database: AppDatabase,
  cipher: CredentialCipher,
  provider: CredentialProviderId,
  generateId: IdGenerator = createUuidV7,
): ProviderCredentialStore {
  const scopeConfiguration: ConnectionScopeConfiguration = {
    associationTable: providerCredentialWorkspaces,
    generateId,
    ownerIdColumn: providerCredentialWorkspaces.providerCredentialId,
    ownerTable: providerCredentials,
  };
  function validateScopes(
    userId: string,
    workspaceIds: readonly string[],
  ): readonly string[] {
    return validateConnectionScopes(database, userId, workspaceIds);
  }
  function add(
    ...parameters: AddCredentialArguments
  ): ProviderCredentialSummary {
    const [
      userId,
      credential,
      details,
      source,
      now,
      workspaceIds = [GLOBAL_WORKSPACE_ID],
    ] = parameters;
    const fingerprint = storedCredentialFingerprint({
      ...(details.apiFormat === undefined
        ? {}
        : { apiFormat: details.apiFormat }),
      ...(details.baseUrl === undefined ? {} : { baseUrl: details.baseUrl }),
      credential,
    });

    const existing = database
      .select({
        id: providerCredentials.id,
        isDeleted: providerCredentials.isDeleted,
      })
      .from(providerCredentials)
      .where(fingerprintCondition(provider, userId, fingerprint))
      .get();
    if (existing !== undefined && !existing.isDeleted) {
      throw createDuplicateProviderCredentialError();
    }
    const id = existing?.id ?? generateId(now);
    const normalizedScopes = validateScopes(userId, workspaceIds);
    const isGlobal = normalizedScopes.includes(GLOBAL_WORKSPACE_ID);
    const encryptedCredential = encryptedCredentialValue({
      cipher: cipher,
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
    return database.transaction((transaction) => {
      if (existing === undefined) {
        transaction
          .insert(providerCredentials)
          .values({
            ...mutableValues,
            createdAt: timestamp,
            createdById: userId,
            credentialFingerprint: fingerprint,
            id,
            provider: provider,
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
        scopeConfiguration,
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
  function list(
    userId: string,
    workspaceId?: string,
  ): readonly ProviderCredentialSummary[] {
    return activeCredentialSummaries(
      database,
      provider,
      userId,
      workspaceId,
    ).map((credential) => ({
      ...credential,
      workspaceIds: workspaceIdsForCredential(userId, credential.id),
    }));
  }
  function workspaceIdsForCredential(
    userId: string,
    credentialId: string,
  ): readonly string[] {
    return readConnectionScopes(
      database,
      scopeConfiguration,
      userId,
      credentialId,
    );
  }
  function readStored(userId: string, credentialId: string) {
    return database.query.providerCredentials
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
        where: activeCredentialCondition(userId, credentialId),
      })
      .sync();
  }
  function read(
    userId: string,
    ...[credentialId, workspaceId]: [credentialId: string, workspaceId?: string]
  ): ProviderCredentialAccess | undefined {
    const stored = readStored(userId, credentialId);
    if (
      stored === undefined ||
      (workspaceId !== undefined &&
        !connectionWorkspaceIsAvailable(database, userId, workspaceId)) ||
      !connectionIsAccessible(
        {
          isGlobal: stored.isGlobal,
          workspaceIds: workspaceIdsForCredential(userId, credentialId),
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
        cipher: cipher,
        credentialId,
        encryptedCredential: stored.encryptedCredential,
        userId,
      }),
      source: stored.source,
      workspaceIds: workspaceIdsForCredential(userId, credentialId),
    };
    return workspaceId === undefined
      ? { ...legacyCredentialSummary(summary), secret: summary.secret }
      : summary;
  }
  function readSecret(
    userId: string,
    credentialId: string,
    workspaceId?: string,
  ): string | undefined {
    return read(userId, credentialId, workspaceId)?.secret;
  }

  function activeCredentialCondition(userId: string, credentialId: string) {
    return ownedActiveCredentialCondition({
      credentialId,
      provider: provider,
      userId,
    });
  }

  function setScopes(...parameters: SetScopesArguments): boolean {
    const [userId, credentialId, workspaceIds, now] = parameters;
    const storedId = matchingCredentialId(
      database,
      activeCredentialCondition(userId, credentialId),
    );
    if (storedId === undefined) return false;
    const normalizedScopes = validateScopes(userId, workspaceIds);
    return database.transaction((transaction) => {
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
        scopeConfiguration,
        userId,
        credentialId,
        normalizedScopes,
        now,
      );
      return true;
    });
  }
  function setDefault(
    userId: string,
    credentialId: string,
    now: number,
  ): boolean {
    let changed = false;
    database.transaction((transaction) => {
      const activeId = matchingCredentialId(
        transaction,
        activeCredentialCondition(userId, credentialId),
      );
      if (activeId === undefined) return;
      transaction
        .update(providerCredentials)
        .set(defaultValues(userId, now, false))
        .where(
          ownedDefaultCondition(
            userId,
            provider === "brave_search" ? "brave_search" : undefined,
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

  function markRequiresReauthentication(
    userId: string,
    credentialId: string,
    now: number,
  ): boolean {
    return markCredentialRequiresReauthentication(
      credentialState(userId, credentialId, now),
    );
  }

  function updateSecret(...parameters: UpdateSecretArguments): boolean {
    const [
      userId,
      credentialId,
      secret,
      now,
      requireReauthentication,
      accountId,
      label,
    ] = parameters;
    try {
      return updateCredentialSecret({
        ...credentialState(userId, credentialId, now),
        cipher: cipher,
        secret,
        ...(requireReauthentication === undefined
          ? {}
          : { requireReauthentication }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(label === undefined ? {} : { label }),
      });
    } catch (error) {
      if (isCredentialFingerprintCollision(error)) {
        throw createDuplicateProviderCredentialError();
      }
      throw error;
    }
  }

  function credentialState(userId: string, credentialId: string, now: number) {
    return {
      credentialId,
      database: database,
      now,
      provider: provider,
      userId,
    };
  }
  function remove(userId: string, credentialId: string, now: number): boolean {
    const condition = activeCredentialCondition(userId, credentialId);
    const storedId = matchingCredentialId(database, condition);
    if (storedId === undefined) return false;
    database.transaction((transaction) => {
      const scopeArguments = [
        transaction,
        scopeConfiguration,
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
  return {
    validateScopes,
    add,
    list,
    read,
    readSecret,
    setScopes,
    setDefault,
    markRequiresReauthentication,
    updateSecret,
    remove,
  };
}
