import { and, asc, eq, inArray, not, or, type SQL } from "drizzle-orm";
import { accessibleConnectionIds } from "./connection-access.ts";
import { connectionWorkspaceIsAvailable } from "./connection-scopes.ts";
import { escapedLikePattern, lowerLike } from "./database-search.ts";
import type { AppDatabase } from "./database.ts";
import {
  providerCredentials,
  providerCredentialWorkspaces,
} from "./database/schema.ts";
import type {
  CredentialProviderId,
  ProviderCredentialSummary,
} from "./provider-credential-store.ts";
import {
  MODEL_PROVIDER_IDS,
  type ProviderApiFormat,
  type ProviderId,
} from "./provider-id.ts";

export function activeCredentialCondition(
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

export function ownedDefaultCondition(
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

export function credentialOrder() {
  return [asc(providerCredentials.createdAt), asc(providerCredentials.id)];
}

export function credentialSummarySelection() {
  return {
    accountId: providerCredentials.providerAccountId,
    apiFormat: providerCredentials.apiFormat,
    baseUrl: providerCredentials.baseUrl,
    id: providerCredentials.id,
    isDefault: providerCredentials.isDefault,
    isGlobal: providerCredentials.isGlobal,
    label: providerCredentials.label,
    source: providerCredentials.source,
  };
}

export function withEndpointFields<
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

function accessibleActiveCredentialCondition(options: {
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
  return and(
    activeCredentialCondition(
      options.provider,
      options.userId,
      options.credentialId,
    ),
    accessibleIds === undefined
      ? undefined
      : inArray(providerCredentials.id, accessibleIds),
  );
}

export function credentialScope(
  database: AppDatabase,
  provider: CredentialProviderId,
  userId: string,
  credentialId: string | undefined,
  workspaceId: string | undefined,
): SQL | undefined {
  return accessibleActiveCredentialCondition(
    Object.assign(
      { database, provider, userId },
      credentialId === undefined ? {} : { credentialId },
      workspaceId === undefined ? {} : { workspaceId },
    ),
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
    .where(credentialScope(database, provider, userId, undefined, workspaceId))
    .orderBy(...credentialOrder())
    .all()
    .map(withEndpointFields);
}

export function accessibleCredentialIds(
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
    activeCredentialCondition(provider, userId),
  );
}

export function matchingCredentialId(
  ...[database, condition]: readonly [
    database: Pick<AppDatabase, "select">,
    condition: SQL | undefined,
  ]
): string | undefined {
  const selection = database.select({ id: providerCredentials.id });
  return selection.from(providerCredentials).where(condition).get()?.id;
}

export function fingerprintCondition(
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

export function modelCredentialCondition(
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

export function legacyCredentialSummary(
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

export interface ProviderCredentialPage {
  readonly items: readonly (ProviderCredentialSummary & {
    readonly provider: ProviderId;
  })[];
  readonly totalItems: number;
}
