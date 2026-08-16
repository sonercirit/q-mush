import { describe, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { CredentialPoolBalancer } from "../../shared/credential-pool-balancer.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import type { SessionForkInput } from "../../shared/session-fork.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery.ts";
import { ModelCredentialPool } from "../model-credential-pool.ts";
import { forkSessionForUser } from "../session-realtime-fork.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  createTestProviderCredential,
  TEST_AUTHENTICATED_USER,
  TEST_NOW,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";

const FIRST_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000091";
const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000092";
const FORK_DETAIL = { ...TEST_SESSION_DETAIL, id: "fork-session" };
const FORKED_RESULT = { detail: FORK_DETAIL, status: "forked" as const };
const BALANCED_INPUT: SessionForkInput = {
  credentialId: balancedCredentialId("openai"),
  forkPointMessageId: "message-1",
  model: TEST_SESSION_DETAIL.model,
  provider: "openai",
  sourceSessionId: TEST_SESSION_DETAIL.id,
  workspaceId: TEST_WORKSPACE_ID,
};

function forkSetup(discoverModels: Parameters<typeof forkDependencies>[0]) {
  const database = createAuthenticatedTestDatabase();
  const credentials = [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID].map((id) => {
    addTestProviderCredential(database, id);
    return createTestProviderCredential(id);
  });
  const storeFork = vi.fn(() => FORKED_RESULT);
  const modelCredentialPool = new ModelCredentialPool(
    {
      database,
      readCredential: (_userId, selection) =>
        Promise.resolve(
          credentials.find(({ id }) => id === selection.credentialId),
        ),
    },
    new CredentialPoolBalancer({ now: () => TEST_NOW }),
  );
  return {
    database,
    dependencies: forkDependencies(
      discoverModels,
      modelCredentialPool,
      storeFork,
    ),
    storeFork,
  };
}

function singleCredentialPool() {
  return {
    candidates: () =>
      Promise.resolve([createTestProviderCredential(FIRST_CREDENTIAL_ID)]),
    reject: () => false,
  } satisfies Pick<ModelCredentialPool, "candidates" | "reject">;
}

function forkDependencies(
  discoverModels: (credentialId: string) => Promise<AgentModelCatalog>,
  modelCredentialPool?: ModelCredentialPool,
  storeFork = vi.fn(() => FORKED_RESULT),
) {
  return {
    credential: () => Promise.reject(new Error("unexpected credential read")),
    discoverModels: (_provider: unknown, credential: { readonly id: string }) =>
      discoverModels(credential.id),
    discoverOpenRouterProviders: () =>
      Promise.reject(new Error("unexpected provider discovery")),
    modelCredentialPool: modelCredentialPool ?? singleCredentialPool(),
    notify: vi.fn(),
    now: () => TEST_NOW,
    store: { fork: storeFork },
  };
}

function catalog(contextWindow = 128_000, adaptiveThinking = false) {
  return {
    defaultModel: TEST_SESSION_DETAIL.model,
    models: [
      {
        adaptiveThinking,
        contextWindow,
        id: TEST_SESSION_DETAIL.model,
        inputModalities: ["text"],
        label: "Test model",
        maxOutputTokens: null,
        outputModalities: ["text"],
        pricing: null,
        reasoningEfforts: [] as const,
      },
    ],
  };
}

async function fork(
  dependencies: ReturnType<typeof forkDependencies>,
  input: SessionForkInput = BALANCED_INPUT,
) {
  return forkSessionForUser({
    compact: () => Promise.resolve(FORK_DETAIL),
    dependencies,
    input,
    source: TEST_SESSION_DETAIL,
    user: TEST_AUTHENTICATED_USER,
  });
}

describe("balanced session forks", () => {
  test("falls through a rejected credential", async () => {
    const discovered: string[] = [];
    const setup = forkSetup((credentialId) => {
      discovered.push(credentialId);
      return credentialId === FIRST_CREDENTIAL_ID
        ? Promise.reject(new AgentModelDiscoveryError("rejected", 401))
        : Promise.resolve(catalog());
    });

    await expect(fork(setup.dependencies)).resolves.toEqual(FORK_DETAIL);
    expect(discovered).toEqual([FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID]);
    expect(setup.storeFork).toHaveBeenCalledWith(
      TEST_AUTHENTICATED_USER.id,
      TEST_SESSION_DETAIL.id,
      BALANCED_INPUT.forkPointMessageId,
      TEST_WORKSPACE_ID,
      TEST_NOW,
      expect.objectContaining({
        adaptiveThinking: false,
        credentialId: SECOND_CREDENTIAL_ID,
      }),
    );
    setup.database.$client.close();
  });

  test("returns a transient probe error without durable writes", async () => {
    const setup = forkSetup(() =>
      Promise.reject(new AgentModelDiscoveryError("offline", 503)),
    );

    await expect(fork(setup.dependencies)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(setup.storeFork).not.toHaveBeenCalled();
    setup.database.$client.close();
  });

  test("preserves explicit credential metadata fallback", async () => {
    const storeFork = vi.fn(() => FORKED_RESULT);
    const dependencies = forkDependencies(
      () => Promise.reject(new AgentModelDiscoveryError("offline", 503)),
      undefined,
      storeFork,
    );
    const input = { ...BALANCED_INPUT, credentialId: FIRST_CREDENTIAL_ID };

    await expect(fork(dependencies, input)).resolves.toEqual(FORK_DETAIL);
    expect(storeFork).toHaveBeenCalledWith(
      TEST_AUTHENTICATED_USER.id,
      TEST_SESSION_DETAIL.id,
      input.forkPointMessageId,
      TEST_WORKSPACE_ID,
      TEST_NOW,
      expect.objectContaining({
        credentialId: FIRST_CREDENTIAL_ID,
        maxContextTokens: null,
        providerPricing: null,
      }),
    );
  });
});
