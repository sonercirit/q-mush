import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import type { AgentModelRequestOptions } from "../agent-model-options.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "../session-agent-runtime.ts";
import type { SessionStoreRuntime } from "../session-store-runtime.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  completingTestBroker,
  IDLE_RUNTIME_SIGNALS,
} from "./session-agent-runtime-test-helpers.ts";
import { unusedSessionToolActions } from "./session-agent-tool-test-helpers.ts";
import {
  requireCompactionSession,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

type RuntimeModelMetadata = Parameters<
  SessionStoreRuntime["setRuntimeModelMetadata"]
>[2];

// Sessions created before the request-metadata columns - or reassigned onto
// an Anthropic-format credential - refresh catalog metadata before requesting.
interface RefreshMetadata {
  readonly adaptiveThinking: boolean | null;
  readonly maxOutputTokens: number | null;
}

describe("lazy Anthropic request metadata refresh", () => {
  interface RefreshHarness {
    readonly detail: ReturnType<typeof requireCompactionSession>;
    readonly discoveryCalls: () => number;
    readonly runtime: Parameters<typeof runSessionAgent>[0];
    readonly persisted: () => RefreshMetadata | undefined;
    readonly selections: AgentModelRequestOptions[];
    readonly close: () => void;
  }

  function setCurrentMetadata(
    setup: ReturnType<typeof runningCompactionStore>,
    metadata: RefreshMetadata,
  ): void {
    const detail = requireCompactionSession(setup.store);
    setup.database
      .update(agentSessions)
      .set(metadata)
      .where(eq(agentSessions.id, detail.id))
      .run();
  }

  function clearAdaptiveThinking(
    setup: ReturnType<typeof runningCompactionStore>,
  ): void {
    const detail = requireCompactionSession(setup.store);
    setCurrentMetadata(setup, {
      adaptiveThinking: null,
      maxOutputTokens: detail.maxOutputTokens,
    });
  }

  function refreshHarness(options: {
    readonly adaptiveThinking?: boolean | null;
    readonly apiFormat?: "anthropic" | "openai";
    readonly currentAdaptiveThinking?: boolean | null;
    readonly currentMaxOutputTokens?: number | null;
    readonly discoveryFails?: boolean;
    readonly maxOutputTokens?: number | null;
    readonly steps: readonly string[];
  }): RefreshHarness {
    let discoveryCalls = 0;
    const setup = runningCompactionStore();
    const detail = requireCompactionSession(setup.store);
    const currentMetadata = {
      adaptiveThinking: options.currentAdaptiveThinking ?? null,
      maxOutputTokens: options.currentMaxOutputTokens ?? null,
    };
    setCurrentMetadata(setup, currentMetadata);
    const runtimeDetail = {
      ...requireCompactionSession(setup.store),
      provider: "generic" as const,
    };
    expect({
      adaptiveThinking: runtimeDetail.adaptiveThinking,
      maxOutputTokens: runtimeDetail.maxOutputTokens,
    }).toEqual(currentMetadata);
    const model = createScriptedAgentModel(
      options.steps.map((content) => ({ content, toolCalls: [] })),
    );
    const selections: AgentModelRequestOptions[] = [];
    const abort = new AbortController();
    let now = 1_700_000_000_100;
    const runtime = {
      braveSearch: { execute: () => Promise.resolve("unused") },
      broker: completingTestBroker(),
      credential: {
        accountId: null,
        apiFormat: options.apiFormat ?? ("anthropic" as const),
        baseUrl: "https://anthropic.example.test/v1",
        id: detail.credentialId,
        isDefault: true,
        label: "Refresh credential",
        secret: "anthropic-secret",
        source: "api_key" as const,
      },
      detail: runtimeDetail,
      discoverModels: () => {
        discoveryCalls += 1;
        return options.discoveryFails === true
          ? Promise.reject(new Error("Discovery unavailable"))
          : Promise.resolve(
              testAgentModelCatalog({
                adaptiveThinking:
                  options.adaptiveThinking === undefined
                    ? false
                    : options.adaptiveThinking,
                id: detail.model,
                maxOutputTokens:
                  options.maxOutputTokens === undefined
                    ? 64_000
                    : options.maxOutputTokens,
              }),
            );
      },
      ...IDLE_RUNTIME_SIGNALS,
      isCurrent: () => true,
      pendingComponent: () => undefined,
      modelFactory: (factoryOptions: AgentModelRequestOptions) => {
        selections.push(factoryOptions);
        return model;
      },
      now: () => (now += 1),
      sessionTools: unusedSessionToolActions(),
      signal: abort.signal,
      store: setup.store,
      userId: TEST_USER_ID,
    };
    return {
      close: () => {
        closeSessionTestDatabase(setup.database);
      },
      detail,
      discoveryCalls: () => discoveryCalls,
      persisted: () => {
        const session = setup.store.get(TEST_USER_ID, detail.id);
        return session === undefined
          ? undefined
          : {
              adaptiveThinking: session.adaptiveThinking,
              maxOutputTokens: session.maxOutputTokens,
            };
      },
      runtime,
      selections,
    };
  }

  async function runRefresh(options: {
    readonly apiFormat?: "anthropic" | "openai";
    readonly discoveryFails?: boolean;
  }): Promise<{
    readonly discoveryCalls: number;
    readonly persisted: RefreshMetadata | undefined;
    readonly selected: AgentModelRequestOptions | undefined;
  }> {
    const harness = refreshHarness({
      ...options,
      steps: ["One durable answer."],
    });
    expect(await runSessionAgent(harness.runtime)).toBe("complete");
    const persisted = harness.persisted();
    harness.close();
    return {
      discoveryCalls: harness.discoveryCalls(),
      persisted,
      selected: harness.selections[0],
    };
  }

  test("discovers, persists, and uses catalog request metadata", async () => {
    const { persisted, selected } = await runRefresh({});

    expect(selected).toMatchObject({
      adaptiveThinking: false,
      maxOutputTokens: 64_000,
    });
    expect(persisted).toEqual({
      adaptiveThinking: false,
      maxOutputTokens: 64_000,
    });
  });

  async function expectRequestMetadata(
    harness: RefreshHarness,
    expected: RefreshMetadata,
  ): Promise<void> {
    const outcome = await runSessionAgent(harness.runtime);
    expect(outcome).toBe("complete");
    expect(harness.selections).toMatchObject([expected]);
    const persisted = harness.persisted();
    harness.close();
    expect(persisted).toEqual(expected);
  }

  test.each([
    {
      discovered: { adaptiveThinking: false, maxOutputTokens: 64_000 },
      expected: { adaptiveThinking: false, maxOutputTokens: 32_000 },
      persisted: { adaptiveThinking: null, maxOutputTokens: 32_000 },
      title: "preserves a known output limit while refreshing adaptive support",
    },
    {
      discovered: { adaptiveThinking: true, maxOutputTokens: 64_000 },
      expected: { adaptiveThinking: false, maxOutputTokens: 64_000 },
      persisted: { adaptiveThinking: false, maxOutputTokens: null },
      title:
        "preserves known adaptive non-support while refreshing the output limit",
    },
  ])("$title", async ({ discovered, expected, persisted }) => {
    const harness = refreshHarness({
      adaptiveThinking: discovered.adaptiveThinking,
      currentAdaptiveThinking: persisted.adaptiveThinking,
      currentMaxOutputTokens: persisted.maxOutputTokens,
      maxOutputTokens: discovered.maxOutputTokens,
      steps: ["Done."],
    });

    await expectRequestMetadata(harness, expected);
  });

  test("persists adaptive support when the output limit stays unknown", async () => {
    const harness = refreshHarness({ maxOutputTokens: null, steps: ["Done."] });
    const expected = {
      adaptiveThinking: false,
      maxOutputTokens: null,
    };

    await expectRequestMetadata(harness, expected);
  });

  test("probes the catalog once across a compact-and-continue run", async () => {
    const harness = refreshHarness({
      steps: ["Compaction handoff.", "Continued after compaction."],
    });

    expect(await compactSessionConversation(harness.runtime, true)).toBe(
      "complete",
    );
    expect(await runSessionAgent(harness.runtime)).toBe("complete");

    // The launch-time detail snapshot stays null, but the continuation's
    // loadModels must reuse the limit the compaction phase persisted
    // instead of probing the catalog again.
    expect(harness.discoveryCalls()).toBe(1);
    harness.close();
  });

  function expectUnrefreshed(outcome: {
    readonly persisted: RefreshMetadata | undefined;
    readonly selected: AgentModelRequestOptions | undefined;
  }): void {
    expect(outcome.selected).toMatchObject({
      adaptiveThinking: null,
      maxOutputTokens: null,
    });
    expect(outcome.persisted).toEqual({
      adaptiveThinking: null,
      maxOutputTokens: null,
    });
  }

  test("leaves the omission when discovery fails", async () => {
    expectUnrefreshed(await runRefresh({ discoveryFails: true }));
  });

  test("propagates a stop instead of reading it as a missing limit", async () => {
    const abort = new AbortController();
    const harness = refreshHarness({ steps: ["Unreached."] });
    const runtime = {
      ...harness.runtime,
      // The run is stopped while the refresh probe is in flight; discovery
      // rejects with the caller's own abort, which must settle the run
      // instead of degrading to an omitted max_tokens.
      discoverModels: (
        _provider: unknown,
        _credential: unknown,
        signal?: AbortSignal,
      ) => {
        expect(signal).not.toBe(abort.signal);
        expect(signal?.aborted).toBe(false);
        abort.abort(new DOMException("Stopped", "AbortError"));
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBe(abort.signal.reason);
        return Promise.reject(
          new DOMException("The agent session was stopped", "AbortError"),
        );
      },
      signal: abort.signal,
    };

    await expect(runSessionAgent(runtime)).rejects.toThrow("stopped");
    expect(harness.selections).toHaveLength(0);
    harness.close();
  });

  test("skips discovery entirely for non-Anthropic formats", async () => {
    const outcome = await runRefresh({ apiFormat: "openai" });

    expectUnrefreshed(outcome);
    expect(outcome.discoveryCalls).toBe(0);
  });

  test("drops a discovery result raced by credential reassignment", () => {
    const setup = runningCompactionStore();
    clearAdaptiveThinking(setup);
    const writeMetadata = (
      credentialId: string,
      metadata: RuntimeModelMetadata,
      at: number,
    ) => {
      const detail = requireCompactionSession(setup.store);
      setup.store.setRuntimeModelMetadata(
        detail.id,
        credentialId,
        metadata,
        at,
        detail.generation,
      );
      const refreshed = setup.store.get(TEST_USER_ID, detail.id);
      return refreshed === undefined
        ? undefined
        : {
            adaptiveThinking: refreshed.adaptiveThinking,
            maxOutputTokens: refreshed.maxOutputTokens,
          };
    };
    const attachedCredentialId = requireCompactionSession(
      setup.store,
    ).credentialId;
    const unknown = { adaptiveThinking: null, maxOutputTokens: null };

    // The reassignment swapped credentials while discovery was in flight;
    // stale metadata must not attach to the new endpoint.
    expect(
      writeMetadata(
        "replaced-credential",
        { adaptiveThinking: false, maxOutputTokens: 64_000 },
        1_700_000_000_200,
      ),
    ).toEqual(unknown);
    // The attached credential's own discovery persists both fields.
    expect(
      writeMetadata(
        attachedCredentialId,
        { adaptiveThinking: false, maxOutputTokens: 32_000 },
        1_700_000_000_300,
      ),
    ).toEqual({ adaptiveThinking: false, maxOutputTokens: 32_000 });
    // Known metadata never gets overwritten by a late duplicate.
    expect(
      writeMetadata(
        attachedCredentialId,
        { adaptiveThinking: true, maxOutputTokens: 16_000 },
        1_700_000_000_400,
      ),
    ).toEqual({ adaptiveThinking: false, maxOutputTokens: 32_000 });
    closeSessionTestDatabase(setup.database);
  });
});
