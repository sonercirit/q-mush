import { describe, expect, test, vi } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { ModelConversationCompactor } from "../../sync-engine/agent-compaction.ts";
import {
  compactSessionConversation,
  type SessionAgentRuntimeDependencies,
} from "../../sync-engine/session-agent-runtime.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  completeNullRunnerCommand,
  expectCompactedIdleSession,
  requireCompactionSession,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import { promiseGate } from "./session-race-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

const SESSION_ID = STORE_SESSION_ID;

interface ManualRuntimeSetup {
  readonly controller: AbortController;
  readonly database: ReturnType<typeof runningCompactionStore>["database"];
  readonly detail: AgentSessionDetail;
  readonly runtime: SessionAgentRuntimeDependencies;
  readonly store: SessionStore;
}

function gatedModel(
  gate: ReturnType<typeof promiseGate<AgentModelTurn>>,
): AgentModel {
  return { complete: () => gate.wait() };
}

function runningManualStore() {
  const setup = runningCompactionStore();
  const detail = requireCompactionSession(setup.store);
  return { ...setup, detail };
}

function runtimeDependencies(options: {
  readonly controller: AbortController;
  readonly detail: AgentSessionDetail;
  readonly model: AgentModel;
  readonly store: SessionStore;
}): SessionAgentRuntimeDependencies {
  let now = TEST_NOW + 2;
  return {
    braveSearch: { execute: () => Promise.resolve("unused search") },
    broker: new RunnerCommandBroker(),
    credential: {
      accountId: null,
      id: options.detail.credentialId,
      isDefault: true,
      label: "Manual compaction credential",
      secret: "provider-secret",
      source: "api_key",
    },
    detail: options.detail,
    hasPendingSteeringInput: () => false,
    isCurrent: () =>
      options.store.executionIsCurrent(
        TEST_USER_ID,
        SESSION_ID,
        options.detail.generation,
      ),
    modelFactory: () => options.model,
    now: () => (now += 1),
    notify: () => undefined,
    realtime: undefined,
    restartHandoffRequested: () => false,
    sessionTools: {
      browseRunnerDirectories: () => Promise.resolve("unused directories"),
      continueSession: () => Promise.resolve("unused continuation"),
      getSessionOptions: () => Promise.resolve("unused options"),
      listRunners: () => "unused runners",
      listSessions: () => "unused sessions",
      readSession: () => "unused session",
      reassignSession: () => "unused reassignment",
      sendToSession: () => Promise.resolve("unused message"),
      spawnSession: () => Promise.resolve("unused spawn"),
      stopSession: () => "unused stop",
    },
    signal: options.controller.signal,
    store: options.store,
    userId: TEST_USER_ID,
  };
}

function manualRuntime(
  model: AgentModel,
  controller = new AbortController(),
): ManualRuntimeSetup {
  const setup = runningManualStore();
  return {
    ...setup,
    controller,
    runtime: runtimeDependencies({ ...setup, controller, model }),
  };
}

function completeAgentFile(runtime: SessionAgentRuntimeDependencies): void {
  const command = runtime.broker.take(runtime.detail.runnerId);
  if (command === undefined) {
    throw new Error("The agent-file command was not queued");
  }
  completeNullRunnerCommand(
    runtime.broker,
    runtime.detail.runnerId,
    command.id,
  );
}

async function startManualCompaction(
  runtime: SessionAgentRuntimeDependencies,
): Promise<"complete" | "handoff"> {
  const compaction = compactSessionConversation(runtime);
  await Promise.resolve();
  completeAgentFile(runtime);
  await Promise.resolve();
  return compaction;
}

function compactionState(setup: ManualRuntimeSetup): unknown {
  const session = setup.store.get(TEST_USER_ID, SESSION_ID);
  return session === undefined
    ? undefined
    : {
        basis: session.costBasis,
        context: session.currentContextTokens,
        cost: session.costUsd,
        transcript: session.messages,
        status: session.status,
      };
}

function compactorTurn(content: string): AgentModelTurn {
  return {
    content,
    contextTokens: null,
    costUsd: 0.4,
    thinking: "",
    tokenUsage: null,
    toolCalls: [],
  };
}

async function expectFailureWithoutCompaction(
  setup: ManualRuntimeSetup,
  compaction: Promise<"complete" | "handoff">,
  expected: string | { readonly name: string },
): Promise<void> {
  const before = compactionState(setup);
  const rejection = expect(compaction).rejects;
  if (typeof expected === "string") {
    await rejection.toThrow(expected);
  } else {
    await rejection.toMatchObject(expected);
  }
  expect(compactionState(setup)).toEqual(before);
  closeSessionTestDatabase(setup.database);
}

async function runGatedManualCompaction(options: {
  readonly afterEntered: (setup: ManualRuntimeSetup) => void;
  readonly controller?: AbortController;
  readonly summary: string;
}): Promise<void> {
  const gate = promiseGate<AgentModelTurn>();
  const setup = manualRuntime(
    gatedModel(gate),
    options.controller ?? new AbortController(),
  );
  const compaction = startManualCompaction(setup.runtime);
  await gate.entered;
  options.afterEntered(setup);
  gate.release(compactorTurn(options.summary));
  await expectFailureWithoutCompaction(setup, compaction, {
    name: "AbortError",
  });
}

describe("manual session compaction", () => {
  test("does not persist an abort-ignoring compactor result", async () => {
    const controller = new AbortController();
    await runGatedManualCompaction({
      afterEntered: () => {
        controller.abort();
      },
      controller,
      summary: "Aborted manual handoff",
    });
  });

  test("fences handoff and usage when execution authority changes", async () => {
    await runGatedManualCompaction({
      afterEntered: (setup) => {
        expect(setup.store.stop(TEST_USER_ID, SESSION_ID, TEST_NOW + 10)).toBe(
          true,
        );
      },
      summary: "Stale manual handoff",
    });
  });

  test("rejects invalid summary usage without charging untrusted output", async () => {
    const setup = manualRuntime(
      new ScriptedAgentModel([
        {
          content: "",
          costUsd: 0.4,
          tokenUsage: {
            cacheWriteInputTokens: 0,
            cachedInputTokens: 0,
            inputTokens: 100,
            outputTokens: 5,
          },
          toolCalls: [],
        },
      ]),
    );
    const before = requireCompactionSession(setup.store);
    await expect(startManualCompaction(setup.runtime)).rejects.toThrow(
      "invalid compaction summary",
    );
    const after = requireCompactionSession(setup.store);
    expect(after.messages).toEqual(before.messages);
    expect(after.costBasis).toBe("none");
    expect(after.costUsd).toBe(0);
    closeSessionTestDatabase(setup.database);
  });

  test("surfaces invalid summary usage as explicitly unbillable", async () => {
    const compactorModel = new ScriptedAgentModel([
      { content: "", costUsd: 0.4, toolCalls: [] },
    ]);
    const compactor = new ModelConversationCompactor(compactorModel);

    await expect(
      compactor.compact([{ content: "Original", role: "user" }]),
    ).rejects.toMatchObject({
      name: "InvalidCompactionSummaryError",
      usage: {
        contextTokens: null,
        costBasis: null,
        costUsd: null,
        tokenUsage: null,
      },
    });
  });

  test("returns complete when restart becomes pending after durable compaction", async () => {
    const running = runningManualStore();
    let restartRequested = false;
    const persisted = running.store.compactRuntimeTerminal.bind(running.store);
    const record = vi
      .spyOn(running.store, "compactRuntimeTerminal")
      .mockImplementation((...arguments_) => {
        persisted(...arguments_);
        restartRequested = true;
      });
    const runtime: SessionAgentRuntimeDependencies = {
      ...runtimeDependencies({
        ...running,
        controller: new AbortController(),
        model: new ScriptedAgentModel([
          {
            content: "Durable restart-race handoff",
            costUsd: 0.4,
            toolCalls: [],
          },
        ]),
      }),
      restartHandoffRequested: () => restartRequested,
    };

    await expect(startManualCompaction(runtime)).resolves.toBe("complete");
    expect(record).toHaveBeenCalledOnce();
    const settled = expectCompactedIdleSession(
      running.store,
      "Durable restart-race handoff",
      { contextTokens: 0 },
    );
    expect(settled.restartHandoff).toBeNull();
    record.mockRestore();
    closeSessionTestDatabase(running.database);
  });

  test("persists reported compaction usage exactly once with the handoff", async () => {
    const setup = manualRuntime(
      new ScriptedAgentModel([
        { content: "Manual handoff", costUsd: 0.4, toolCalls: [] },
      ]),
    );

    await startManualCompaction(setup.runtime);

    expect(setup.store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      costBasis: "reported",
      costUsd: 0.4,
      currentContextTokens: 0,
      messages: [
        {
          content: "Conversation compacted:\n\nManual handoff",
          role: "user",
        },
      ],
    });
    closeSessionTestDatabase(setup.database);
  });
});
