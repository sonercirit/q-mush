import { describe, expect, test } from "vitest";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
} from "../../sync-engine/session-agent-models.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

const CREDENTIAL: ProviderCredentialAccess = {
  accountId: null,
  id: "credential-1",
  isDefault: false,
  label: "OpenRouter",
  secret: "provider-secret",
  source: "api_key",
};

describe("session model serving-provider selection", () => {
  test("passes the persisted tag to both the normal agent and compactor", () => {
    const selections: { readonly openRouterProviderTag?: string }[] = [];
    const factory: AgentModelFactory = (options) => {
      selections.push(options);
      return new ScriptedAgentModel([]);
    };
    const models = createSessionAgentModels({
      agentFile: null,
      credential: CREDENTIAL,
      detail: {
        ...TEST_SESSION_DETAIL,
        credentialId: CREDENTIAL.id,
        openRouterProviderTag: "google-vertex/us",
        provider: "openrouter",
      },
      factory,
      id: () => "stream-id",
      isCurrent: () => true,
      realtime: undefined,
      userId: "user-1",
    });

    models.createCompactor();

    expect(selections).toMatchObject([
      { openRouterProviderTag: "google-vertex/us" },
      { openRouterProviderTag: "google-vertex/us" },
    ]);
  });
});
