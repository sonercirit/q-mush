import type { CreateAgentSession } from "../../sync-engine/session-store-create.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";

export function createSessionInput(options: {
  readonly credentialId: string;
  readonly prompt: string;
  readonly runnerId: string;
  readonly workingDirectory?: string;
}): CreateAgentSession {
  return {
    autoCompact: true,
    credentialId: options.credentialId,
    images: [],
    maxContextTokens: null,
    model: "gpt-4.1-mini",
    prompt: options.prompt,
    provider: "openai",
    providerPricing: null,
    reasoningEffort: null,
    runnerId: options.runnerId,
    tools: [],
    userId: TEST_USER_ID,
    workingDirectory: options.workingDirectory ?? "/work/project",
  };
}

function unavailableSessionInput(options: {
  readonly parent?: { readonly generation: number; readonly id: string };
  readonly prompt: string;
  readonly runnerId: string;
}): CreateAgentSession {
  const input = createSessionInput({
    credentialId: "018bcfe5-6800-7000-8000-000000000042",
    prompt: options.prompt,
    runnerId: options.runnerId,
  });
  return options.parent === undefined
    ? input
    : {
        ...input,
        parentGeneration: options.parent.generation,
        parentSessionId: options.parent.id,
      };
}

export function createUnavailableSession(
  store: SessionStore,
  runnerId: string,
  prompt: string,
  parent?: { readonly generation: number; readonly id: string },
) {
  return store.create(
    unavailableSessionInput({
      ...(parent === undefined ? {} : { parent }),
      prompt,
      runnerId,
    }),
    TEST_NOW + 3,
  );
}
