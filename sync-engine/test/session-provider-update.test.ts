import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import {
  agentMessages,
  agentSessions,
  agentSessionTurns,
} from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { applySessionProviderUpdate } from "../session-provider-update.ts";
import { SessionRestartAbort } from "../session-restart-abort.ts";
import { SessionStore } from "../session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { testModelCatalog } from "./session-continuation-test-helpers.ts";
import { restartCanceledDiscovery } from "./session-restart-gate-fixtures.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";

function createProviderUpdateSession(
  store: SessionStore,
  userContextTokenCap?: number,
) {
  const values = {
    adaptiveThinking: null,
    autoCompact: true,
    credentialId: "openai-source",
    executionEnvironment: "bare_metal" as const,
    images: [],
    maxContextTokens: 128_000,
    maxOutputTokens: null,
    model: "gpt-4.1-mini",
    openRouterProviderTag: null,
    prompt: "Initial context",
    provider: "openai" as const,
    providerPricing: null,
    reasoningEffort: null,
    runnerId: "runner-1",
    tools: [],
    ...(userContextTokenCap === undefined ? {} : { userContextTokenCap }),
    userId: TEST_USER_ID,
    workingDirectory: "/tmp",
    workspaceId: TEST_WORKSPACE_ID,
  };
  return store.create(values, TEST_NOW);
}

function setup(userContextTokenCap?: number) {
  const database = createAuthenticatedTestDatabase();
  addSessionTestRunner(database, "provider-update-machine", "runner-1");
  addTestProviderCredential(database, "openai-source");
  addTestProviderCredential(database, "openrouter-target", "openrouter");
  const readSettings = () => DEFAULT_TOOL_SETTINGS;
  const store = new SessionStore(database, undefined, readSettings);
  const created = createProviderUpdateSession(store, userContextTokenCap);
  if (created.status !== "created") throw new Error("Fixture failed");
  const cancelSessionGeneration = vi.fn<
    (_sessionId: string, _generation: number) => readonly []
  >(() => []);
  const abortForGeneration = vi.fn<
    (_sessionId: string, _generation: number) => boolean
  >(() => true);
  const readCredential = vi.fn(
    (_userId: string, credentialId: string, workspaceId?: string) =>
      workspaceId === TEST_WORKSPACE_ID && credentialId === "openrouter-target"
        ? {
            accountId: null,
            id: credentialId,
            isDefault: false,
            label: "OpenRouter",
            secret: "secret",
            source: "api_key" as const,
          }
        : undefined,
  );
  const dependencies = {
    broker: { cancelSessionGeneration },
    discoverModels: () =>
      Promise.resolve(testModelCatalog("vendor/model", "Model")),
    discoverOpenRouterProviders: () =>
      Promise.resolve({
        providers: [
          {
            contextWindow: 64_000,
            name: "Together",
            pricing: { input: "0.1", output: "0.2" },
            tag: "together",
          },
        ],
      }),
    now: () => TEST_NOW + 1,
    providers: {
      openai: { readCredential: () => undefined },
      openrouter: { readCredential },
    },
    restartSignal: () => new AbortController().signal,
    runtimes: { abortForGeneration },
    store: {
      database,
      read: (identity: readonly [string, string, string]) =>
        store.get(...identity),
    },
  };
  const input = {
    confirmedCacheDrop: true,
    credentialId: "openrouter-target",
    expectedGeneration: created.detail.generation,
    model: "vendor/model",
    openRouterProviderTag: "together",
    provider: "openrouter" as const,
    sessionId: created.detail.id,
    workspaceId: TEST_WORKSPACE_ID,
  };
  return { created, database, dependencies, input, store };
}

function sessionRow(setupValue: ReturnType<typeof setup>) {
  return setupValue.database
    .select({
      contextTokens: agentSessions.currentContextTokens,
      credentialId: agentSessions.providerCredentialId,
      generation: agentSessions.executionGeneration,
      maxContextTokens: agentSessions.maxContextTokens,
      maxOutputTokens: agentSessions.maxOutputTokens,
      model: agentSessions.model,
      pricing: agentSessions.providerPricing,
      provider: agentSessions.provider,
      segment: agentSessions.currentSegment,
      tag: agentSessions.openRouterProviderTag,
      userContextTokenCap: agentSessions.userContextTokenCap,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, setupValue.created.detail.id))
    .get();
}

interface UntaggedMetadata {
  readonly adaptiveThinking?: boolean;
  readonly maxOutputTokens?: number;
}

function untaggedCatalog(metadata: Readonly<UntaggedMetadata>) {
  const [option] = testModelCatalog("vendor/model", "Model").models;
  if (option === undefined) throw new Error("Fixture catalog is empty");
  return Promise.resolve({
    defaultModel: option.id,
    models: [{ ...option, ...metadata }],
  });
}

describe("session provider update", () => {
  const applyUpdate = (
    setupValue: ReturnType<typeof setup>,
    confirmedCacheDrop = true,
  ) =>
    applySessionProviderUpdate(setupValue.dependencies, TEST_USER_ID, {
      ...setupValue.input,
      confirmedCacheDrop,
    });

  async function applyUntaggedMetadata(
    setupValue: ReturnType<typeof setup>,
    metadata: Readonly<UntaggedMetadata>,
  ) {
    setupValue.dependencies.discoverModels = () => untaggedCatalog(metadata);
    return applySessionProviderUpdate(setupValue.dependencies, TEST_USER_ID, {
      ...setupValue.input,
      openRouterProviderTag: null,
    });
  }

  async function persistedUntaggedMetadata(
    metadata: Readonly<UntaggedMetadata>,
  ) {
    const setupValue = setup();
    const updated = await applyUntaggedMetadata(setupValue, metadata);
    return { setupValue, updated };
  }

  test("updates provider metadata and drops the current cache segment once", async () => {
    const setupValue = setup();

    const updated = await applyUpdate(setupValue);

    expect(updated).toMatchObject({
      credentialId: "openrouter-target",
      currentContextTokens: 0,
      generation: 1,
      hasOlderSegments: true,
      maxContextTokens: 64_000,
      model: "vendor/model",
      openRouterProviderTag: "together",
      provider: "openrouter",
      providerPricing: { input: "0.1", output: "0.2" },
    });
    expect(updated.turns).toHaveLength(0);
    const storedTurns = setupValue.database
      .select({ endedAt: agentSessionTurns.endedAt })
      .from(agentSessionTurns)
      .all();
    expect(storedTurns).toHaveLength(1);
    expect(storedTurns[0]?.endedAt).toBeInstanceOf(Date);
    expect(sessionRow(setupValue)).toMatchObject({
      contextTokens: 0,
      credentialId: "openrouter-target",
      generation: 1,
      maxContextTokens: 64_000,
      model: "vendor/model",
      provider: "openrouter",
      segment: 1,
      tag: "together",
    });
    expect(
      setupValue.database
        .select({ segment: agentMessages.segment })
        .from(agentMessages)
        .all(),
    ).toEqual([{ segment: 0 }]);
    expect(setupValue.store.get(TEST_USER_ID, updated.id)?.messages).toEqual(
      [],
    );
    const abortCalls = setupValue.dependencies.runtimes.abortForGeneration;
    expect(abortCalls).toHaveBeenCalledWith(updated.id, 0);

    const repeated = await applySessionProviderUpdate(
      setupValue.dependencies,
      TEST_USER_ID,
      { ...setupValue.input, confirmedCacheDrop: false },
    );
    expect(repeated.generation).toBe(1);
    expect(sessionRow(setupValue)?.segment).toBe(1);
    expect(abortCalls).toHaveBeenCalledTimes(1);
    expect(
      setupValue.store.queue(TEST_USER_ID, updated.id, TEST_NOW + 2).status,
    ).toBe("queued");
  });

  test("persists the catalog output limit for untagged model targets", async () => {
    const { setupValue, updated } = await persistedUntaggedMetadata({
      maxOutputTokens: 64_000,
    });

    expect(updated.maxOutputTokens).toBe(64_000);
    expect(sessionRow(setupValue)?.maxOutputTokens).toBe(64_000);
  });

  test("persists adaptive-thinking capability for untagged model targets", async () => {
    const { setupValue, updated } = await persistedUntaggedMetadata({
      adaptiveThinking: false,
    });

    expect(updated.adaptiveThinking).toBe(false);
    expect(
      setupValue.store.get(TEST_USER_ID, updated.id)?.adaptiveThinking,
    ).toBe(false);
  });

  test("retains a cap below the target model limit", async () => {
    const setupValue = setup(32_000);

    const updated = await applyUpdate(setupValue);

    expect(updated).toMatchObject({
      maxContextTokens: 32_000,
      userContextTokenCap: 32_000,
    });
    expect(sessionRow(setupValue)).toMatchObject({
      maxContextTokens: 64_000,
      userContextTokenCap: 32_000,
    });
  });

  test("rejects a target model below the retained cap", async () => {
    const setupValue = setup(120_000);

    await expect(applyUpdate(setupValue)).rejects.toMatchObject({
      code: "invalid_context_token_cap",
      message:
        "The current context token cap of 120,000 tokens exceeds the new model limit of 64,000 tokens. Lower or clear the cap before changing models.",
    });
    expect(sessionRow(setupValue)).toMatchObject({
      generation: 0,
      maxContextTokens: 128_000,
      model: "gpt-4.1-mini",
      provider: "openai",
      segment: 0,
      userContextTokenCap: 120_000,
    });
    expect(
      setupValue.dependencies.runtimes.abortForGeneration,
    ).not.toHaveBeenCalled();
    expect(
      setupValue.dependencies.broker.cancelSessionGeneration,
    ).not.toHaveBeenCalled();
  });

  const expectRejectedUpdate = async (
    setupValue: ReturnType<typeof setup>,
    confirmedCacheDrop: boolean,
    code: string,
  ): Promise<void> => {
    try {
      await applyUpdate(setupValue, confirmedCacheDrop);
      throw new Error("The provider update unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  };

  async function expectRestartBlockedWithoutMutation(
    setupValue: ReturnType<typeof setup>,
  ): Promise<void> {
    await expect(applyUpdate(setupValue)).rejects.toMatchObject({
      code: "server_restarting",
    });
    expect(sessionRow(setupValue)).toMatchObject({ generation: 0 });
  }

  test("returns server_restarting without mutating when discovery is canceled", async () => {
    const setupValue = setup();
    const canceled = restartCanceledDiscovery();
    setupValue.dependencies.restartSignal = () => canceled.controller.signal;
    setupValue.dependencies.discoverOpenRouterProviders = canceled.discover;

    await expectRestartBlockedWithoutMutation(setupValue);
  });

  test("recovery replacement cannot mutate after credential lookup", async () => {
    const setupValue = setup();
    const restart = new SessionRestartAbort();
    setupValue.dependencies.restartSignal = () => restart.signal;
    const readCredential =
      setupValue.dependencies.providers.openrouter.readCredential;
    setupValue.dependencies.providers.openrouter.readCredential = vi.fn(
      (...parameters) => {
        restart.abort("restart");
        restart.restore();
        return readCredential(...parameters);
      },
    );

    await expectRestartBlockedWithoutMutation(setupValue);
  });

  test("requires confirmation before changing the provider", async () => {
    const setupValue = setup();

    await expectRejectedUpdate(setupValue, false, "cache_warning_required");
    expect(sessionRow(setupValue)).toMatchObject({ provider: "openai" });
  });

  test("enforces workspace credential scope before discovery or mutation", async () => {
    const setupValue = setup();
    const scopedReader = vi.fn(() => undefined);
    setupValue.dependencies.providers.openrouter.readCredential = scopedReader;

    await expectRejectedUpdate(setupValue, true, "credential_unavailable");
    expect(scopedReader).toHaveBeenCalledWith(
      TEST_USER_ID,
      "openrouter-target",
      TEST_WORKSPACE_ID,
    );
    expect(sessionRow(setupValue)).toEqual(
      expect.objectContaining({ provider: "openai" }),
    );
  });
});
