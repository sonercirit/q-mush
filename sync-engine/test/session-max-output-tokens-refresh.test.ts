import { describe, expect, test } from "vitest";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import type { AgentModelRequestOptions } from "../agent-model-options.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "../session-agent-runtime.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
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

// Sessions created before the max_output_tokens column - or reassigned onto
// an Anthropic-format credential - have no persisted output limit even
// though Messages requests require max_tokens.
describe("lazy max output tokens refresh", () => {
  interface RefreshHarness {
    readonly detail: ReturnType<typeof requireCompactionSession>;
    readonly discoveryCalls: () => number;
    readonly runtime: Parameters<typeof runSessionAgent>[0];
    readonly persisted: () => number | null | undefined;
    readonly selections: AgentModelRequestOptions[];
    readonly close: () => void;
  }

  function refreshHarness(options: {
    readonly apiFormat?: "anthropic" | "openai";
    readonly discoveryFails?: boolean;
    readonly steps: readonly string[];
  }): RefreshHarness {
    let discoveryCalls = 0;
    const setup = runningCompactionStore();
    const detail = requireCompactionSession(setup.store);
    expect(detail.maxOutputTokens).toBeNull();
    const model = new ScriptedAgentModel(
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
      detail: { ...detail, provider: "generic" as const },
      discoverModels: () => {
        discoveryCalls += 1;
        return options.discoveryFails === true
          ? Promise.reject(new Error("Discovery unavailable"))
          : Promise.resolve(
              testAgentModelCatalog({
                id: detail.model,
                maxOutputTokens: 64_000,
              }),
            );
      },
      ...IDLE_RUNTIME_SIGNALS,
      isCurrent: () => true,
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
      persisted: () =>
        setup.store.get(TEST_USER_ID, detail.id)?.maxOutputTokens,
      runtime,
      selections,
    };
  }

  async function runRefresh(options: {
    readonly apiFormat?: "anthropic" | "openai";
    readonly discoveryFails?: boolean;
  }): Promise<{
    readonly discoveryCalls: number;
    readonly persisted: number | null | undefined;
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

  test("discovers, persists, and uses the catalog limit before the first request", async () => {
    const { persisted, selected } = await runRefresh({});

    expect(selected).toMatchObject({ maxOutputTokens: 64_000 });
    expect(persisted).toBe(64_000);
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
    readonly persisted: number | null | undefined;
    readonly selected: AgentModelRequestOptions | undefined;
  }): void {
    expect(outcome.selected).toMatchObject({ maxOutputTokens: null });
    expect(outcome.persisted).toBeNull();
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
        expect(signal).toBe(abort.signal);
        abort.abort(new DOMException("Stopped", "AbortError"));
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
    const writeLimit = (credentialId: string, limit: number, at: number) => {
      const detail = requireCompactionSession(setup.store);
      setup.store.setRuntimeMaxOutputTokens(
        detail.id,
        credentialId,
        limit,
        at,
        detail.generation,
      );
      return setup.store.get(TEST_USER_ID, detail.id)?.maxOutputTokens;
    };
    const attachedCredentialId = requireCompactionSession(
      setup.store,
    ).credentialId;

    // The reassignment swapped credentials while discovery was in flight;
    // the stale credential's limit must not attach to the new endpoint.
    expect(writeLimit("replaced-credential", 64_000, 1_700_000_000_200)).toBe(
      null,
    );
    // The attached credential's own discovery still persists.
    expect(writeLimit(attachedCredentialId, 32_000, 1_700_000_000_300)).toBe(
      32_000,
    );
    // A set limit never gets overwritten by a late duplicate.
    expect(writeLimit(attachedCredentialId, 16_000, 1_700_000_000_400)).toBe(
      32_000,
    );
    closeSessionTestDatabase(setup.database);
  });
});
