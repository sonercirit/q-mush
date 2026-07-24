import { describe, expect, test } from "vitest";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import {
  AGENT_COMPACTION_SYSTEM_PROMPT,
  ModelConversationCompactor,
} from "../../sync-engine/agent-compaction.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
} from "../../sync-engine/session-agent-models.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { TEST_SESSION_DETAIL } from "./session-detail-fixture.ts";

const CREDENTIAL: ProviderCredentialAccess = {
  accountId: null,
  id: "credential-1",
  isDefault: false,
  label: "OpenRouter",
  secret: "provider-secret",
  source: "api_key",
};

function detail(tag: string | null): AgentSessionDetail {
  return {
    ...TEST_SESSION_DETAIL,
    credentialId: CREDENTIAL.id,
    currentContextTokens: 0,
    maxContextTokens: 128_000,
    model: "vendor/model",
    openRouterProviderTag: tag,
    provider: "openrouter",
    status: "running",
    title: "Test",
  };
}

function captureModels(tag: string | null): {
  readonly models: ReturnType<typeof createSessionAgentModels>;
  readonly selections: {
    readonly openRouterProviderTag?: string;
    readonly systemPrompt: string;
  }[];
} {
  const selections: {
    readonly openRouterProviderTag?: string;
    readonly systemPrompt: string;
  }[] = [];
  const factory: AgentModelFactory = (options) => {
    selections.push(options);
    return new ScriptedAgentModel([]);
  };
  return {
    models: createSessionAgentModels({
      agentFile: null,
      credential: CREDENTIAL,
      detail: detail(tag),
      factory,
      realtime: undefined,
      userId: "user-1",
    }),
    selections,
  };
}

describe("session agent model construction", () => {
  test("passes the selected serving provider to the agent and automatic compactor", () => {
    const { models, selections } = captureModels("google-vertex/us");

    expect(models.createCompactor()).toBeInstanceOf(ModelConversationCompactor);
    expect(selections).toMatchObject([
      { openRouterProviderTag: "google-vertex/us" },
      {
        openRouterProviderTag: "google-vertex/us",
        systemPrompt: AGENT_COMPACTION_SYSTEM_PROMPT,
      },
    ]);
  });

  test("omits an explicit serving provider for automatic routing", () => {
    const { models, selections } = captureModels(null);

    models.createCompactor();
    expect(selections).toHaveLength(2);
    for (const selection of selections) {
      expect(selection).not.toHaveProperty("openRouterProviderTag");
    }
  });
});
