import type { CreateAgentSession } from "../../sync-engine/session-store-create.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";

function unavailableSessionInput(
  runnerId: string,
  prompt: string,
  parentSessionId?: string,
): CreateAgentSession {
  return {
    autoCompact: true,
    credentialId: "018bcfe5-6800-7000-8000-000000000042",
    images: [],
    maxContextTokens: null,
    model: "gpt-4.1-mini",
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    prompt,
    provider: "openai",
    providerPricing: null,
    reasoningEffort: null,
    runnerId,
    tools: [],
    userId: TEST_USER_ID,
    workingDirectory: "/work/project",
  };
}

export function createUnavailableSession(
  store: SessionStore,
  runnerId: string,
  prompt: string,
  parentSessionId?: string,
) {
  return store.create(
    unavailableSessionInput(runnerId, prompt, parentSessionId),
    TEST_NOW + 3,
  );
}
