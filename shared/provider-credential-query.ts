import { and, asc, count, eq, inArray, or, type SQL } from "drizzle-orm";
import { accessibleConnectionIds } from "./connection-access.ts";
import { connectionWorkspaceIsAvailable } from "./connection-scopes.ts";
import { escapedLikePattern, lowerLike } from "./database-search.ts";
import type { AppDatabase } from "./database.ts";
import {
  providerCredentials,
  providerCredentialWorkspaces,
} from "./database/schema.ts";
import { validPageWindow } from "./pagination.ts";
import { ownedActiveCredentialCondition } from "./provider-credential-condition.ts";
import type {
  CredentialProviderId,
  ProviderCredentialPage,
  ProviderCredentialSummary,
} from "./provider-credential-model.ts";
import {
  isProviderId,
  MODEL_PROVIDER_IDS,
  type ProviderApiFormat,
  type ProviderId,
} from "./provider-id.ts";

function activeProviderCondition(
  provider: CredentialProviderId,
  userId: string,
): SQL | undefined {
  return and(
    eq(providerCredentials.provider, provider),
    eq(providerCredentials.userId, userId),
    eq(providerCredentials.isDeleted, false),
  );
}

function credentialOrder() {
  return [asc(providerCredentials.createdAt), asc(providerCredentials.id)];
}

function credentialSummarySelection() {
  return {
    accountId: providerCredentials.providerAccountId,
    apiFormat: providerCredentials.apiFormat,
    baseUrl: providerCredentials.baseUrl,
    id: providerCredentials.id,
    isDefault: providerCredentials.isDefault,
    isGlobal: providerCredentials.isGlobal,
    label: providerCredentials.label,
    requiresReauthentication: providerCredentials.requiresReauthentication,
    source: providerCredentials.source,
  };
}

function withEndpointFields<
  Credential extends {
    readonly apiFormat: ProviderApiFormat | null;
    readonly baseUrl: string | null;
  },
>({ apiFormat, baseUrl, ...credential }: Credential) {
  return {
    ...credential,
    ...(apiFormat === null ? {} : { apiFormat }),
    ...(baseUrl === null ? {} : { baseUrl }),
  };
}

function accessibleCredentialIds(
  database: AppDatabase,
  provider: CredentialProviderId,
  userId: string,
  workspaceId: string,
): readonly string[] {
  if (!connectionWorkspaceIsAvailable(database, userId, workspaceId)) {
    return [];
  }
  return accessibleConnectionIds(
    database,
    {
      associationOwnerId: providerCredentialWorkspaces.providerCredentialId,
      associationTable: providerCredentialWorkspaces,
      ownerGlobal: providerCredentials.isGlobal,
      ownerId: providerCredentials.id,
      ownerTable: providerCredentials,
    },
    userId,
    workspaceId,
    activeProviderCondition(provider, userId),
  );
}

function credentialScope(options: {
  readonly credentialId?: string;
  readonly database: AppDatabase;
  readonly provider: CredentialProviderId;
  readonly userId: string;
  readonly workspaceId?: string;
}): SQL | undefined {
  const accessibleIds =
    options.workspaceId === undefined
      ? undefined
      : accessibleCredentialIds(
          options.database,
          options.provider,
          options.userId,
          options.workspaceId,
        );
  const ownerCondition =
    options.credentialId === undefined
      ? activeProviderCondition(options.provider, options.userId)
      : ownedActiveCredentialCondition({
          credentialId: options.credentialId,
          provider: options.provider,
          userId: options.userId,
        });
  return and(
    ownerCondition,
    accessibleIds === undefined
      ? undefined
      : inArray(providerCredentials.id, accessibleIds),
  );
}

export function activeCredentialSummaries(
  database: AppDatabase,
  provider: CredentialProviderId,
  userId: string,
  workspaceId?: string,
): readonly ProviderCredentialSummary[] {
  return database
    .select(credentialSummarySelection())
    .from(providerCredentials)
    .where(
      credentialScope({
        database,
        provider,
        userId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }),
    )
    .orderBy(...credentialOrder())
    .all()
    .map(withEndpointFields);
}

function modelCredentialCondition(
  userId: string,
  search?: string,
  accessibleIds?: readonly string[],
) {
  const base = and(
    eq(providerCredentials.userId, userId),
    eq(providerCredentials.isDeleted, false),
    inArray(providerCredentials.provider, MODEL_PROVIDER_IDS),
    accessibleIds === undefined
      ? undefined
      : inArray(providerCredentials.id, accessibleIds),
  );
  if (search === undefined) {
    return base;
  }
  const pattern = escapedLikePattern(search);
  return and(
    base,
    or(
      lowerLike(providerCredentials.id, pattern),
      lowerLike(providerCredentials.baseUrl, pattern),
      lowerLike(providerCredentials.providerAccountId, pattern),
      lowerLike(providerCredentials.label, pattern),
      lowerLike(providerCredentials.provider, pattern),
      lowerLike(providerCredentials.source, pattern),
    ),
  );
}

export function modelCredentialIsActive(
  database: AppDatabase,
  userId: string,
  provider: ProviderId,
  credentialId: string,
  workspaceId?: string,
): boolean {
  const options = { credentialId, database, provider, userId };
  return (
    database
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(
        and(
          credentialScope(
            workspaceId === undefined ? options : { ...options, workspaceId },
          ),
          eq(providerCredentials.requiresReauthentication, false),
        ),
      )
      .get() !== undefined
  );
}

export function queryActiveModelCredentials(
  database: AppDatabase,
  userId: string,
  provider: ProviderId,
  workspaceId?: string,
): readonly ProviderCredentialSummary[] {
  const summaries = activeCredentialSummaries(
    database,
    provider,
    userId,
    workspaceId,
  );
  return summaries.filter(
    (credential) => credential.requiresReauthentication !== true,
  );
}

export interface ModelCredentialQueryOptions {
  readonly pageSize: number;
  readonly skip: number;
  readonly search?: string;
  readonly workspaceId?: string;
}

export function queryModelCredentials(
  database: AppDatabase,
  userId: string,
  options: ModelCredentialQueryOptions,
): ProviderCredentialPage {
  const { pageSize: limit, search, skip: offset, workspaceId } = options;
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
  return { items, totalItems };
}
