import type { AgentProviderCredential } from "../../sync-engine/agent-model-options.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";

export function testApiKeyCredential(
  secret: string,
  overrides: Partial<AgentProviderCredential> = {},
): AgentProviderCredential {
  return {
    accountId: null,
    id: "test-api-key-credential",
    secret,
    source: "api_key",
    ...overrides,
  };
}

export function testOpenAiOAuthCredential(): AgentProviderCredential {
  return {
    accountId: "chatgpt-account",
    id: "test-oauth-credential",
    secret: createOpenAiOAuthSecret(),
    source: "oauth",
  };
}
