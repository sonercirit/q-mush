import { expect, test, vi, type MockInstance } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { createAgentSystemPrompt } from "../../shared/agent-prompt.ts";
import { agentMessages, agentSessions } from "../../shared/database/schema.ts";
import {
  createRunnerCommandBroker,
  type RunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import type { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import type { AgentModelFactory } from "../../sync-engine/session-agent-models.ts";
import type { SessionAgentRuntimeDependencies } from "../../sync-engine/session-agent-runtime.ts";
import {
  createSessionFinisher,
  type SessionFinisher,
} from "../../sync-engine/session-finisher.ts";
import type { SessionLauncher } from "../../sync-engine/session-launcher.ts";
import { recoverSessionRestartHandoffs } from "../../sync-engine/session-restart-recovery.ts";
import type {
  RestartHandoffIdentity,
  RestartHandoffSettlement,
} from "../../sync-engine/session-restart-store.ts";
import {
  createSessionRuntimes,
  type SessionRuntimes,
} from "../../sync-engine/session-runtime.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { TEST_COMPACTION_REQUEST_MESSAGE } from "./compaction-test-fixtures.ts";
import { expectDoneStep, providerStep } from "./provider-step-fixtures.ts";
import {
  closeCompactionStore,
  expectCompactedIdleSession,
  pauseRestartStore,
  requireCompactionSession,
  runningRestartStore,
  type RestartStoreSetup,
} from "./session-compaction-test-helpers.ts";
import {
  completeLaunchAgentFile,
  runLaunchedSession,
} from "./session-launch-test-helpers.ts";
import { createTestSessionLauncher } from "./session-launcher-fixtures.ts";
import { settleRestartRecovery } from "./session-restart-cpd-helpers.ts";
import {
  CREDENTIAL,
  orchestrationActions,
} from "./session-restart-orchestration-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

interface RecoveredRunSetup {
  readonly actionsFinished: MockInstance<SessionAgentActions["finished"]>;
  readonly broker: RunnerCommandBroker;
  readonly detail: AgentSessionDetail;
  readonly identity: RestartHandoffIdentity;
  readonly launcher: SessionLauncher;
  readonly modelFactories: MockInstance<
    SessionAgentRuntimeDependencies["modelFactory"]
  >;
  readonly notifications: string[];
  readonly notify: MockInstance<(userId: string, sessionId: string) => void>;
  readonly runtimes: SessionRuntimes;
  readonly settle: MockInstance<SessionStore["settleRestartHandoff"]>;
  readonly storeSetup: RestartStoreSetup;
}

function modelTurn(
  content: string,
  overrides: Partial<AgentModelStep> = {},
): AgentModelStep {
  const step = providerStep(content, overrides);
  if (content === "Done.") {
    expectDoneStep(step);
  }
  return step;
}

function recoveredRunSetup(model: AgentModel): RecoveredRunSetup {
  const storeSetup = runningRestartStore();
  const identity = pauseRestartStore(
    storeSetup,
    "restart-orchestration",
    "agent",
  );
  const detail = storeSetup.restart.claim(TEST_USER_ID, identity, TEST_NOW + 3);
  if (detail === undefined) {
    throw new Error("The recovered orchestration handoff was not claimable");
  }
  const notifications: string[] = [];
  const notify = vi.fn((userId: string, sessionId: string): void => {
    notifications.push(`${userId}:${sessionId}`);
  });
  const actions = orchestrationActions(storeSetup.database, storeSetup.store);
  const actionsFinished = vi.spyOn(actions, "finished");
  const store = storeSetup.store;
  const finisher = createSessionFinisher({
    actions,
    notify,
    now: () => TEST_NOW + 5,
    store,
  });
  const broker = createRunnerCommandBroker({
    commandId: () => "restart-agent-file-command",
  });
  const runtimes = createSessionRuntimes();
  const modelFactories = vi.fn(() => model);
  const launcher = createTestSessionLauncher({
    actions,
    broker,
    finish: (finishedDetail, userId, error, recovered) => {
      finisher.finish(finishedDetail, userId, error, recovered);
    },
    modelFactory: modelFactories,
    notify,
    now: (() => {
      let now = TEST_NOW + 3;
      return () => (now += 1);
    })(),
    runtimes,
    store,
  });
  return {
    actionsFinished,
    broker,
    detail,
    identity,
    launcher,
    modelFactories,
    notifications,
    notify,
    runtimes,
    settle: vi.spyOn(store, "settleRestartHandoff"),
    storeSetup,
  };
}

interface ManualCompactionSetup {
  readonly broker: RunnerCommandBroker;
  readonly compactionWrite:
    MockInstance<SessionStore["compactRuntimeTerminal"]> | undefined;
  readonly compactorRequests: AgentConversationMessage[][];
  readonly detail: AgentSessionDetail;
  readonly finishes: MockInstance<SessionFinisher["finish"]>;
  readonly launcher: SessionLauncher;
  readonly modelFactories: MockInstance<
    SessionAgentRuntimeDependencies["modelFactory"]
  >;
  readonly runtimes: SessionRuntimes;
  readonly storeSetup: ReturnType<typeof createStore>;
}

function manualCompactionSetup(
  onCompactionPersisted?: () => void,
): ManualCompactionSetup {
  const storeSetup = createStore();
  const detail = createTestSession(storeSetup.store);
  const actions = orchestrationActions(storeSetup.database, storeSetup.store);
  const broker = createRunnerCommandBroker({
    commandId: () => "manual-compaction-agent-file",
  });
  const runtimes = createSessionRuntimes();
  const compactorRequests: AgentConversationMessage[][] = [];
  const modelFactories = vi.fn<AgentModelFactory>((options) => ({
    complete: (messages: readonly AgentConversationMessage[]) => {
      if (
        options.systemPrompt !==
        createAgentSystemPrompt(
          null,
          detail.executionEnvironment,
          DEFAULT_TOOL_SETTINGS,
        )
      ) {
        return Promise.reject(new Error("The agent model was unexpected"));
      }
      compactorRequests.push([...messages]);
      return Promise.resolve(modelTurn("Durable manual restart summary."));
    },
  }));
  const finisher = createSessionFinisher({
    actions,
    notify: () => undefined,
    now: () => TEST_NOW + 5,
    store: storeSetup.store,
  });
  const finish = vi.fn<SessionFinisher["finish"]>((...arguments_) => {
    finisher.finish(...arguments_);
  });

  const launcher = createTestSessionLauncher({
    actions,
    broker,
    finish,
    modelFactory: modelFactories,
    notify: () => undefined,
    now: () => TEST_NOW + 4,
    runtimes,
    store: storeSetup.store,
  });
  const persistCompaction = storeSetup.store.compactRuntimeTerminal.bind(
    storeSetup.store,
  );
  const compactionWrite =
    onCompactionPersisted === undefined
      ? undefined
      : vi
          .spyOn(storeSetup.store, "compactRuntimeTerminal")
          .mockImplementation((...arguments_) => {
            persistCompaction(...arguments_);
            onCompactionPersisted();
          });
  return {
    broker,
    compactionWrite,
    compactorRequests,
    detail,
    finishes: finish,
    launcher,
    modelFactories,
    runtimes,
    storeSetup,
  };
}

function launchManualCompaction(
  setup: ManualCompactionSetup,
  detail = setup.detail,
): void {
  expect(
    setup.launcher.launch(detail, CREDENTIAL, TEST_USER_ID, "compact"),
  ).toBe(true);
}

function expectPendingRestartHandoffs(
  setup: ManualCompactionSetup,
  expected: readonly unknown[],
): void {
  expect(setup.storeSetup.store.pendingRestartHandoffs()).toEqual(expected);
}

function expectNoCompactionWork(setup: ManualCompactionSetup): void {
  expect(setup.compactorRequests).toHaveLength(0);
  expect(setup.modelFactories).toHaveBeenCalledTimes(0);
  expect(setup.finishes).not.toHaveBeenCalled();
}

function expectPendingRestartHandoffCount(
  setup: ManualCompactionSetup,
  count: number,
): void {
  expect(setup.storeSetup.store.pendingRestartHandoffs()).toHaveLength(count);
}

function expectRestartHandoffState(
  setup: ManualCompactionSetup,
  status: "paused" | "queued",
): void {
  expect(requireCompactionSession(setup.storeSetup.store)).toMatchObject({
    restartHandoff: {
      operation: "compact",
      restartId: "restart-before-manual-compactor",
    },
    status,
  });
}

function expectCompactionRequest(
  messages: readonly AgentConversationMessage[] | undefined,
): void {
  expect(messages?.at(-1)).toMatchObject({
    content: TEST_COMPACTION_REQUEST_MESSAGE,
    role: "user",
  });
}

function expectCompactionFinished(setup: ManualCompactionSetup): void {
  expect(setup.compactorRequests).toHaveLength(1);
  expectCompactionRequest(setup.compactorRequests[0]);
  expect(setup.finishes).toHaveBeenCalledOnce();
}

async function settleManualCompaction(
  setup: ManualCompactionSetup,
): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  completeLaunchAgentFile(setup.broker, setup.detail);
  await setup.runtimes.settled(setup.detail.id);
}

function closeManualCompaction(setup: ManualCompactionSetup): void {
  setup.compactionWrite?.mockRestore();
  closeCompactionStore(setup.storeSetup);
}

function recoverManualCompaction(setup: ManualCompactionSetup): {
  readonly launches: AgentSessionDetail[];
  readonly recovery: ReturnType<typeof recoverSessionRestartHandoffs>;
} {
  const launches: AgentSessionDetail[] = [];
  const recovery = recoverSessionRestartHandoffs({
    credential: () => Promise.resolve(CREDENTIAL),
    launch: (detail) => {
      launches.push(detail);
      return true;
    },
    notify: () => undefined,
    now: () => TEST_NOW + 6,
    runnerIsAvailable: () => true,
    store: setup.storeSetup.store,
  });
  return { launches, recovery };
}

function recoverAndSettleManualCompaction(
  setup: ManualCompactionSetup,
): Promise<AgentSessionDetail[]> {
  const { launches, recovery } = recoverManualCompaction(setup);
  return recovery.then(() => launches);
}

async function drainManualCompaction(
  setup: ManualCompactionSetup,
  restartId: string,
): Promise<void> {
  await setup.runtimes.drain({ kind: "server" }, restartId);
}

function highContextRecoveredRunSetup(
  model: AgentModel,
  messages: readonly AgentConversationMessage[],
): RecoveredRunSetup {
  const setup = recoveredRunSetup(model);
  setup.storeSetup.database
    .update(agentSessions)
    .set({ currentContextTokens: 195_000 })
    .run();
  let createdAt = TEST_NOW + 10;
  for (const message of messages) {
    if (message.role === "compaction_notice") {
      throw new Error("Recovered fixtures cannot persist compaction markers");
    }
    setup.storeSetup.database
      .insert(agentMessages)
      .values({
        content: message.content,
        createdAt: new Date((createdAt += 1)),
        createdById: TEST_USER_ID,
        id: `restart-message-${String(createdAt)}`,
        isDeleted: false,
        role: message.role,
        sessionId: setup.detail.id,
        ...(message.role === "assistant"
          ? { toolCalls: JSON.stringify(message.toolCalls) }
          : {}),
        ...(message.role === "tool"
          ? {
              toolCallId: message.toolCallId,
              toolName: message.toolName,
            }
          : {}),
        updatedAt: new Date(createdAt),
        updatedById: TEST_USER_ID,
        userId: TEST_USER_ID,
      })
      .run();
  }
  const detail = requireCompactionSession(setup.storeSetup.store);
  return { ...setup, detail };
}

async function runRecovered(setup: RecoveredRunSetup): Promise<void> {
  await runLaunchedSession({
    broker: setup.broker,
    detail: setup.detail,
    launcher: setup.launcher,
    runtimes: setup.runtimes,
  });
}

function invocationOrder(
  mock: MockInstance,
  position: "first" | "last",
): number {
  const calls = mock.mock.invocationCallOrder;
  const order = position === "first" ? calls[0] : calls.at(-1);
  if (order === undefined) {
    throw new Error(`The ${position} expected orchestration call is missing`);
  }
  return order;
}

function expectTerminalReporting(
  setup: RecoveredRunSetup,
  expectedNotifications: number,
): void {
  expect(setup.notifications).toEqual(
    Array.from(
      { length: expectedNotifications },
      () => `${TEST_USER_ID}:${setup.detail.id}`,
    ),
  );
  expect(setup.actionsFinished).toHaveBeenCalledOnce();
  expect(setup.actionsFinished).toHaveBeenCalledWith(
    setup.detail,
    TEST_USER_ID,
  );
  expect(invocationOrder(setup.settle, "first")).toBeLessThan(
    invocationOrder(setup.notify, "last"),
  );
  expect(invocationOrder(setup.notify, "last")).toBeLessThan(
    invocationOrder(setup.actionsFinished, "first"),
  );
  expect(setup.runtimes.active(setup.detail.id)).toBe(false);
}

function expectAtomicSettlement(
  setup: RecoveredRunSetup,
  settlement: RestartHandoffSettlement,
): void {
  expect(setup.settle).toHaveBeenCalledOnce();
  expect(setup.settle).toHaveBeenCalledWith(
    TEST_USER_ID,
    setup.identity,
    settlement,
    TEST_NOW + 5,
  );
}

function persisted(setup: RecoveredRunSetup): AgentSessionDetail {
  return requireCompactionSession(setup.storeSetup.store);
}

function closeRecoveredRun(setup: RecoveredRunSetup): void {
  setup.actionsFinished.mockRestore();
  setup.settle.mockRestore();
  closeCompactionStore(setup.storeSetup);
}

type TerminalSettlement = Parameters<typeof expectAtomicSettlement>[1];

interface TerminalExpectation {
  readonly notifications: number;
  readonly settlement: TerminalSettlement;
  readonly transcript: readonly Readonly<Record<string, unknown>>[];
}

async function expectRecoveredTerminal(
  model: AgentModel,
  expectation: TerminalExpectation,
): Promise<void> {
  const setup = recoveredRunSetup(model);

  await runRecovered(setup);

  expectAtomicSettlement(setup, expectation.settlement);
  expect(persisted(setup)).toMatchObject({
    messages: expectation.transcript,
    restartHandoff: null,
    status: expectation.settlement.status,
  });
  expectTerminalReporting(setup, expectation.notifications);
  closeRecoveredRun(setup);
}

test("launcher settles recovered success before terminal reporting", async () => {
  await expectRecoveredTerminal(
    {
      complete: () => Promise.resolve(modelTurn("Recovered successfully.")),
    },
    {
      notifications: 6,
      settlement: { status: "idle" },
      transcript: [
        { role: "user" },
        { content: "Recovered successfully.", role: "assistant" },
      ],
    },
  );
});

test("launcher settles recovered error before terminal reporting", async () => {
  const error = "Session failed: recovered provider failed";
  await expectRecoveredTerminal(
    {
      complete: () => Promise.reject(new Error("recovered provider failed")),
    },
    {
      notifications: 5,
      settlement: { error, status: "failed" },
      transcript: [{ role: "user" }, { content: error, role: "error" }],
    },
  );
});

test("compaction settles when restart follows its durable write", async () => {
  const setups: ManualCompactionSetup[] = [];
  const setup = manualCompactionSetup(() => {
    const current = setups[0];
    if (current === undefined) {
      throw new Error("The manual compaction fixture was not initialized");
    }
    void current.runtimes.drain(
      { kind: "server" },
      "restart-after-manual-compaction",
    );
  });
  setups.push(setup);

  launchManualCompaction(setup);
  await settleManualCompaction(setup);

  expectCompactionFinished(setup);

  expectCompactedIdleSession(
    setup.storeSetup.store,
    "Durable manual restart summary.",
    { contextTokens: 0 },
  );
  expectPendingRestartHandoffs(setup, []);

  const recoveryLaunches = await recoverAndSettleManualCompaction(setup);
  expect(recoveryLaunches).toEqual([]);
  closeManualCompaction(setup);
});

test("restart before compaction replays one handoff", async () => {
  const setup = manualCompactionSetup();

  launchManualCompaction(setup);
  await drainManualCompaction(setup, "restart-before-manual-compactor");

  expectNoCompactionWork(setup);
  expectRestartHandoffState(setup, "paused");

  expectPendingRestartHandoffCount(setup, 1);

  const recoveryLaunches = await recoverAndSettleManualCompaction(setup);
  expect(recoveryLaunches).toMatchObject([
    {
      restartHandoff: {
        operation: "compact",
        restartId: "restart-before-manual-compactor",
      },
    },
  ]);

  expectPendingRestartHandoffs(setup, []);

  expectRestartHandoffState(setup, "queued");

  const recovered = recoveryLaunches[0];
  if (recovered === undefined) {
    throw new Error("The compact restart handoff was not recovered");
  }
  setup.runtimes.start();
  await settleRestartRecovery();
  launchManualCompaction(setup, recovered);

  await settleManualCompaction(setup);
  expectCompactionFinished(setup);
  expect(requireCompactionSession(setup.storeSetup.store)).toMatchObject({
    restartHandoff: null,
    status: "idle",
  });

  expectPendingRestartHandoffs(setup, []);
  closeManualCompaction(setup);
});

test("recovered tool handoff compacts before its first request", async () => {
  const durableTool: AgentConversationMessage = {
    content: "Durable tool output.",
    role: "tool",
    toolCallId: "durable-tool-call",
    toolName: "read",
  };
  const durableAssistant: AgentConversationMessage = {
    content: "Reading before restart.",
    role: "assistant",
    toolCalls: [
      {
        arguments: "{}",
        id: durableTool.toolCallId,
        name: durableTool.toolName,
      },
    ],
  };
  const steps = [
    modelTurn("Recovered compacted summary."),
    modelTurn("Recovered after compaction.", { contextTokens: 1_000 }),
  ];
  const requests: AgentConversationMessage[][] = [];
  const model: AgentModel = {
    complete: (messages) => {
      requests.push([...messages]);
      const step = steps.shift();
      return step === undefined
        ? Promise.reject(new Error("Unexpected extra provider request"))
        : Promise.resolve(step);
    },
  };
  const setup = highContextRecoveredRunSetup(model, [
    durableAssistant,
    durableTool,
  ]);

  await runRecovered(setup);

  expect(requests).toHaveLength(2);
  expect(requests[0]).toContainEqual(durableTool);
  expectCompactionRequest(requests[0]);
  expect(requests[1]?.[0]?.content).toContain("Recovered compacted summary.");
  expect(requests[1]?.some((message) => message === durableTool)).toBe(false);
  expect(setup.modelFactories).toHaveBeenCalledTimes(2);
  expect(
    setup.modelFactories.mock.calls.map(([options]) => options.systemPrompt),
  ).toEqual([
    createAgentSystemPrompt(
      null,
      setup.detail.executionEnvironment,
      DEFAULT_TOOL_SETTINGS,
    ),
    createAgentSystemPrompt(
      null,
      setup.detail.executionEnvironment,
      DEFAULT_TOOL_SETTINGS,
    ),
  ]);
  const detail = persisted(setup);
  expect(detail).toMatchObject({
    currentContextTokens: 1_000,
    messages: [{ role: "user" }, { content: "Recovered after compaction." }],
    restartHandoff: null,
    status: "idle",
  });
  expect(detail.messages[0]?.content).toContain("Recovered compacted summary.");
  expect(
    setup.storeSetup.database
      .select({
        content: agentMessages.content,
        isDeleted: agentMessages.isDeleted,
      })
      .from(agentMessages)
      .all(),
  ).toContainEqual({ content: durableTool.content, isDeleted: true });
  closeRecoveredRun(setup);
});
