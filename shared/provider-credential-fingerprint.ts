import type { AppDatabase } from "./database.ts";
import { providerCredentials } from "./database/schema.ts";
import { fingerprintCondition } from "./provider-credential-store-query.ts";
import type { CredentialProviderId } from "./provider-credential-store.ts";

export function credentialFingerprintOwner(
  database: Pick<AppDatabase, "select">,
  provider: CredentialProviderId,
  userId: string,
  fingerprint: string,
): { readonly id: string; readonly isDeleted: boolean } | undefined {
  return database
    .select({
      id: providerCredentials.id,
      isDeleted: providerCredentials.isDeleted,
    })
    .from(providerCredentials)
    .where(fingerprintCondition(provider, userId, fingerprint))
    .get();
}
