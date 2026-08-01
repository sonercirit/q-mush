import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { runPersistedSession } from "../../sync-engine/session-run.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  closeCompactionStore,
  completeNullRunnerCommand,
  requireCompactionSession,
} from "./session-compaction-test-helpers.ts";
import {
  expectRestartState,
  recoverRestartTestHandoffs,
} from "./session-restart-cpd-helpers.ts";
import {
  CREDENTIAL,
  orchestrationActions,
} from "./session-restart-orchestration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_RUNNER_ID,
} from "./session-store-test-fixtures.ts";

interface RestartDisconnectModel extends AgentModel {
  readonly requests: readonly AgentConversationMessage[][];
}

function restartDisconnectModel(
  toolCall: AgentModelStep["toolCalls"][number],
): RestartDisconnectModel {
  const requests: AgentConversationMessage[][] = [];
  return {
    requests,
    complete: (messages) => {
      requests.push([...messages]);
      return Promise.resolve(
        providerStep("Reading before restart.", { toolCalls: [toolCall] }),
      );
    },
  };
}

test("disconnect during an in-flight runner command persists the exact restart handoff", async () => {
  const setup = createStore();
  createTestSession(setup.store);
  const detail = requireCompactionSession(setup.store);
  const model = restartDisconnectModel({
    arguments: "{}",
    id: "call-1",
    name: "read",
  });
  const agentFileDispatched = Promise.withResolvers<undefined>();
  const toolDispatched = Promise.withResolvers<undefined>();
  const broker = new RunnerCommandBroker({
    commandId: (() => {
      const ids = ["agent-file-command", "in-flight-command"];
      return () => ids.shift() ?? "unexpected-command";
    })(),
    deliver: (_runnerId, command) => {
      if (command.id === "agent-file-command") {
        agentFileDispatched.resolve(undefined);
      }
      if (command.id === "in-flight-command") {
        toolDispatched.resolve(undefined);
      }
      return true;
    },
  });
  let restartRequested = false;
  const finishes: unknown[][] = [];
  const run = runPersistedSession({
    controller: new AbortController(),
    credential: CREDENTIAL,
    detail,
    finish: (...arguments_) => {
      finishes.push(arguments_);
    },
    notify: () => undefined,
    now: () => TEST_NOW + 2,
    operation: "agent",
    resources: {
      actions: orchestrationActions(setup.database, setup.store),
      braveSearch: { execute: () => Promise.resolve("unused search") },
      broker,
      modelFactory: () => model,
      now: () => TEST_NOW + 2,
      notify: () => undefined,
      realtime: undefined,
      store: setup.store,
    },
    restartRequest: () =>
      restartRequested
        ? {
            boundary: "handoff",
            requestedBy: "runner",
            restartId: "restart-disconnect",
          }
        : undefined,
    store: setup.store,
    userId: TEST_USER_ID,
  });

  await agentFileDispatched.promise;
  completeNullRunnerCommand(broker, STORE_RUNNER_ID, "agent-file-command");
  await toolDispatched.promise;
  restartRequested = true;
  broker.disconnectRunner(STORE_RUNNER_ID);
  expect(
    broker.complete(STORE_RUNNER_ID, "in-flight-command", {
      output: "stale output",
      state: "completed",
    }),
  ).toBe(false);
  await run;

  expect(finishes).toEqual([]);
  expect(model.requests).toHaveLength(1);
  const persistedAfterDisconnect = requireCompactionSession(setup.store);
  expect(persistedAfterDisconnect).toMatchObject({
    generation: detail.generation + 1,
    messages: [
      { role: "user" },
      { content: "Reading before restart.", role: "assistant" },
      {
        role: "tool",
        toolCallId: "call-1",
      },
    ],
    restartHandoff: {
      executionGeneration: detail.generation + 1,
      operation: "agent",
      requestedBy: "runner",
      restartId: "restart-disconnect",
    },
    status: "paused",
  });
  expect(persistedAfterDisconnect.messages[2]?.content).toContain(
    "retry it after restart",
  );
  expect(setup.store.pendingRestartHandoffs()).toMatchObject([
    {
      handoff: { restartId: "restart-disconnect" },
      userId: TEST_USER_ID,
    },
  ]);
  expect(
    JSON.stringify(requireCompactionSession(setup.store)).includes(
      "stale output",
    ),
  ).toBe(false);

  const recoveries: AgentSessionDetail[] = [];
  const recover = async (restartId: string): Promise<void> => {
    await recoverRestartTestHandoffs({
      credential: () => Promise.resolve(CREDENTIAL),
      launch: (claimed) => {
        recoveries.push(claimed);
        return true;
      },
      now: () => TEST_NOW + 3,
      restartId,
      store: setup.store,
    });
  };
  await recover("wrong-replacement");
  expect(recoveries).toEqual([]);
  await recover("restart-disconnect");
  expect(recoveries).toMatchObject([
    {
      generation: detail.generation + 1,
      restartHandoff: { restartId: "restart-disconnect" },
    },
  ]);
  expectRestartState(
    requireCompactionSession(setup.store),
    {
      generation: detail.generation + 1,
      restartId: "restart-disconnect",
    },
    "queued",
  );
  closeCompactionStore(setup);
});
