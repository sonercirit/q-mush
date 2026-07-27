import type { OpenRouterProviderCatalog } from "../../shared/agent-configuration.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { agentSessions } from "../../shared/database/schema.ts";

const TEST_PRICING = { input: "0.0000002", output: "0.0000008" };

export const TEST_OPENROUTER_PROVIDER_CATALOG: OpenRouterProviderCatalog = {
  providers: [
    {
      contextWindow: 64_000,
      name: "Together",
      pricing: TEST_PRICING,
      tag: "together",
    },
  ],
};

export function openRouterSessionMetadataSelection(database: AppDatabase) {
  return database
    .select({
      credentialId: agentSessions.providerCredentialId,
      maxContextTokens: agentSessions.maxContextTokens,
      openRouterProviderTag: agentSessions.openRouterProviderTag,
      providerPricing: agentSessions.providerPricing,
    })
    .from(agentSessions);
}

export function expectedOpenRouterSessionMetadata(credentialId: string) {
  return {
    credentialId,
    maxContextTokens: 64_000,
    openRouterProviderTag: "together",
    providerPricing: JSON.stringify(TEST_PRICING),
  };
}
