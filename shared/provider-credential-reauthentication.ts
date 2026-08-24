import { and, eq, isNull } from "drizzle-orm";
import { updatedAuditFields } from "./audit.ts";
import type { CredentialCipher } from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import { providerCredentials } from "./database/schema.ts";
import { SYSTEM_ID } from "./ids.ts";
import { ownedActiveCredentialCondition } from "./provider-credential-condition.ts";
import {
  encryptedCredentialValue,
  presentProviderEndpointMetadata,
  storedCredentialFingerprint,
} from "./provider-credential-secret.ts";
import type { ProviderApiFormat } from "./provider-id.ts";

type CredentialProviderId = typeof providerCredentials.$inferSelect.provider;

interface CredentialStateOptions {
  readonly credentialId: string;
  readonly database: AppDatabase;
  readonly now: number;
  readonly provider: CredentialProviderId;
  readonly userId: string;
}

const CREDENTIAL_IDENTITY_CHANGED = new Error("Credential identity changed");

function credentialStateUpdated(
  options: CredentialStateOptions,
  values: Partial<typeof providerCredentials.$inferInsert>,
  requireReauthentication = false,
  accountId?: string,
  endpoint?: {
    readonly apiFormat: ProviderApiFormat | null;
    readonly baseUrl: string | null;
  },
): boolean {
  if (requireReauthentication && accountId === undefined) {
    return false;
  }

  try {
    return options.database.transaction((transaction) => {
      const changed = transaction
        .update(providerCredentials)
        .set(values)
        .where(
          and(
            ownedActiveCredentialCondition(options),
            requireReauthentication
              ? eq(providerCredentials.requiresReauthentication, true)
              : undefined,
            accountId === undefined
              ? undefined
              : eq(providerCredentials.providerAccountId, accountId),
            endpoint === undefined
              ? undefined
              : endpoint.apiFormat === null
                ? isNull(providerCredentials.apiFormat)
                : eq(providerCredentials.apiFormat, endpoint.apiFormat),
            endpoint === undefined
              ? undefined
              : endpoint.baseUrl === null
                ? isNull(providerCredentials.baseUrl)
                : eq(providerCredentials.baseUrl, endpoint.baseUrl),
          ),
        )
        .returning({
          accountId: providerCredentials.providerAccountId,
          id: providerCredentials.id,
        })
        .all();
      if (
        accountId !== undefined &&
        changed.some((credential) => credential.accountId !== accountId)
      ) {
        throw CREDENTIAL_IDENTITY_CHANGED;
      }
      return changed.some(({ id }) => id === options.credentialId);
    });
  } catch (error) {
    if (error === CREDENTIAL_IDENTITY_CHANGED) return false;
    throw error;
  }
}

export function markCredentialRequiresReauthentication(
  options: CredentialStateOptions,
): boolean {
  return credentialStateUpdated(options, {
    requiresReauthentication: true,
    ...updatedAuditFields(SYSTEM_ID, options.now),
  });
}

export function updateCredentialSecret(
  options: CredentialStateOptions & {
    readonly accountId?: string;
    readonly cipher: CredentialCipher;
    readonly label?: string;
    readonly requireReauthentication?: boolean;
    readonly secret: string;
  },
): boolean {
  const stored = options.database
    .select({
      apiFormat: providerCredentials.apiFormat,
      baseUrl: providerCredentials.baseUrl,
    })
    .from(providerCredentials)
    .where(ownedActiveCredentialCondition(options))
    .get();
  if (stored === undefined) {
    return false;
  }

  return credentialStateUpdated(
    options,
    {
      credentialFingerprint: storedCredentialFingerprint({
        ...presentProviderEndpointMetadata(stored),
        credential: options.secret,
      }),
      encryptedCredential: encryptedCredentialValue({
        cipher: options.cipher,
        credential: options.secret,
        credentialId: options.credentialId,
        userId: options.userId,
      }),
      requiresReauthentication: false,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...updatedAuditFields(SYSTEM_ID, options.now),
    },
    options.requireReauthentication ?? false,
    options.accountId,
    stored,
  );
}
