import { and, eq, type SQL } from "drizzle-orm";
import { providerCredentials } from "./database/schema.ts";

type CredentialProviderId = typeof providerCredentials.$inferSelect.provider;

export function ownedActiveCredentialCondition(options: {
  readonly credentialId: string;
  readonly provider: CredentialProviderId;
  readonly userId: string;
}): SQL | undefined {
  return and(
    eq(providerCredentials.userId, options.userId),
    eq(providerCredentials.provider, options.provider),
    eq(providerCredentials.id, options.credentialId),
    eq(providerCredentials.isDeleted, false),
  );
}
