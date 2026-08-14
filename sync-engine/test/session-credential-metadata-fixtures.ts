import type { SessionCredentialMetadataUpdate } from "../session-credential-reassignment-store.ts";

export function testSessionCredentialMetadataUpdate(
  overrides: Partial<SessionCredentialMetadataUpdate> = {},
): SessionCredentialMetadataUpdate {
  return {
    adaptiveThinking: null,
    id: "session-1",
    maxContextTokens: 64_000,
    maxOutputTokens: null,
    providerPricing: null,
    ...overrides,
  };
}
