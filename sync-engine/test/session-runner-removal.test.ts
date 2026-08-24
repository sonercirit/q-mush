import { describe, expect, test } from "vitest";
import {
  createRunnerCommandBroker,
  type RunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { captureBrokerRejection } from "../../shared/test/promise-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import {
  createRunnerRemovalCoordinator,
  type RunnerRemovalCoordinator,
} from "../../sync-engine/session-runner-removal.ts";

const REMOVED_RUNNER_ID = "runner-removed";
const OTHER_RUNNER_ID = "runner-other";
const SESSION_ID = "session-1";

function testSession(): AgentSessionDetail {
  const base = {
    agentFile: null,
    agentFilePath: null,
    autoCompact: true,
    idleCompact: false,
    costBasis: "none" as const,
    provider: "openai" as const,
    status: "idle" as const,
  };
  const runningCalls = ["completed-call", "call-1", "call-2"].map((id) => ({
    arguments: "{}",
    id,
    name: "read",
  }));
  const runningMessage = {
    content: "Running tools.",
    createdAt: 1,
    id: "assistant-1",
    images: [],
    role: "assistant" as const,
    toolCallId: null,
    toolCalls: runningCalls,
    toolName: null,
  };
  return {
    ...base,
    adaptiveThinking: null,
    activeDurationMs: 0,
    activeStartedAt: null,
    stepStartedAt: null,
    costUsd: 0,
    createdAt: 1,
    credentialId: "credential-1",
    currentContextTokens: 0,
    executionEnvironment: "bare_metal",
    maxOutputTokens: null,
    generation: 0,
    hasOlderSegments: false,
    id: SESSION_ID,
    maxContextTokens: null,
    userContextTokenCap: null,
    messages: [
      runningMessage,
      {
        content: "done",
        createdAt: 2,
        id: "completed-tool-message",
        images: [],
        role: "tool",
        toolCallId: "completed-call",
        toolCalls: [],
        toolName: "read",
      },
    ],
    model: "model-1",
    modelContextTokens: null,
    openRouterProviderTag: null,
    pendingInputs: [],
    pendingQuestions: null,
    provider: base.provider,
    providerPricing: null,
    reasoningEffort: null,
    restartHandoff: null,
    runtimePending: null,
    runnerId: REMOVED_RUNNER_ID,
    runnerRequired: true,
    status: base.status,
    title: "Session",
    tools: ["read"],
    updatedAt: 2,
    workingDirectory: "/work",
    workspaceId: "workspace-1",
    parentExecutionGeneration: TEST_SESSION_DETAIL.parentExecutionGeneration,
    parentSessionId: TEST_SESSION_DETAIL.parentSessionId,
  };
}

function dispatch(broker: RunnerCommandBroker, runnerId: string) {
  return broker.dispatch({
    arguments: {},
    executionEnvironment: "bare_metal",
    runnerId,
    sessionId: SESSION_ID,
    tool: "read",
    workingDirectory: "/work",
  });
}

async function expectAborted(
  command: ReturnType<typeof dispatch>,
): Promise<void> {
  expect(await captureBrokerRejection(command)).toMatchObject({
    name: "AbortError",
  });
}

function coordinator(
  broker: RunnerCommandBroker,
  appended: { readonly toolCallId: string; readonly toolName: string }[],
  session = testSession(),
  settled: () => Promise<void> = () => Promise.resolve(),
): RunnerRemovalCoordinator {
  return createRunnerRemovalCoordinator({
    broker,
    notify: () => undefined,
    now: () => 2,
    runtimes: { abort: () => undefined, settled },
    store: {
      appendInterruptedRunnerTool: () => {
        appended.push({ toolCallId: "call-1", toolName: "read" });
      },
      get: () => session,
      list: () => [session],
    },
  });
}

describe("removed session runners", () => {
  test("rechecks command authority at dispatch", async () => {
    let authorized = true;
    const broker = createRunnerCommandBroker();
    authorized = false;

    const command = broker.dispatch({
      arguments: {},
      authorize: () => authorized,
      executionEnvironment: "bare_metal",
      runnerId: REMOVED_RUNNER_ID,
      sessionId: SESSION_ID,
      tool: "read",
      workingDirectory: "/work",
    });

    await expectAborted(command);
    expect(broker.take(REMOVED_RUNNER_ID)).toBeUndefined();
  });

  test("cancels every affected session command and records the unresolved outer call", async () => {
    const ids = ["runner-command-1", "runner-command-2"];
    const broker = createRunnerCommandBroker({
      commandId: () => ids.shift() ?? "unexpected-command",
      deliver: (runnerId) => runnerId === REMOVED_RUNNER_ID,
    });
    const removedRunnerCommand = dispatch(broker, REMOVED_RUNNER_ID);
    const otherRunnerCommand = dispatch(broker, OTHER_RUNNER_ID);
    const appended: {
      readonly toolCallId: string;
      readonly toolName: string;
    }[] = [];

    const removal = coordinator(broker, appended);
    removal.removing("user-1", REMOVED_RUNNER_ID);
    await removal.removed("user-1", REMOVED_RUNNER_ID);

    await expectAborted(removedRunnerCommand);
    await expectAborted(otherRunnerCommand);
    expect(appended).toEqual([{ toolCallId: "call-1", toolName: "read" }]);
    expect(
      broker.complete(OTHER_RUNNER_ID, "runner-command-2", {
        output: "late",
        state: "completed",
      }),
    ).toBe(false);
  });

  test("fences commands before waiting for the database removal callback", async () => {
    const broker = createRunnerCommandBroker({
      commandId: () => "call-1",
      deliver: () => true,
    });
    const command = dispatch(broker, REMOVED_RUNNER_ID);
    const blocked = Promise.withResolvers<undefined>();
    const removal = coordinator(
      broker,
      [],
      testSession(),
      () => blocked.promise,
    );
    removal.removing("user-1", REMOVED_RUNNER_ID);
    const removed = removal.removed("user-1", REMOVED_RUNNER_ID);

    expect(
      broker.complete(REMOVED_RUNNER_ID, "call-1", {
        output: "late result",
        state: "completed",
      }),
    ).toBe(false);
    await expectAborted(command);
    blocked.resolve(undefined);
    await removed;
  });
});
