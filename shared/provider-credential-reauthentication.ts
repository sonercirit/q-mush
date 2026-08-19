import { and, eq } from "drizzle-orm";
import { updatedAuditFields } from "./audit.ts";
import type { CredentialCipher } from "./credential-cipher.ts";
import type { AppDatabase } from "./database.ts";
import { providerCredentials } from "./database/schema.ts";
import { SYSTEM_ID } from "./ids.ts";
import { ownedActiveCredentialCondition } from "./provider-credential-condition.ts";
import {
  encryptedCredentialValue,
  storedCredentialFingerprint,
} from "./provider-credential-secret.ts";

type CredentialProviderId = typeof providerCredentials.$inferSelect.provider;

interface CredentialStateOptions {
  readonly credentialId: string;
  readonly database: AppDatabase;
  readonly now: number;
  readonly provider: CredentialProviderId;
  readonly userId: string;
}

function credentialStateUpdated(
  options: CredentialStateOptions,
  values: Partial<typeof providerCredentials.$inferInsert>,
  requireReauthentication = false,
  accountId?: string,
): boolean {
  if (requireReauthentication && accountId === undefined) {
    return false;
  }

  const changed = options.database
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
      ),
    )
    .returning({ id: providerCredentials.id })
    .all();
  return changed.some(({ id }) => id === options.credentialId);
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
        ...(stored.apiFormat === null ? {} : { apiFormat: stored.apiFormat }),
        ...(stored.baseUrl === null ? {} : { baseUrl: stored.baseUrl }),
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
  );
}
