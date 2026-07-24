import { describe, expect, test } from "vitest";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { captureBrokerRejection } from "../../shared/test/promise-test-helpers.ts";
import { RunnerRemovalCoordinator } from "../../sync-engine/session-runner-removal.ts";

const REMOVED_RUNNER_ID = "runner-removed";
const OTHER_RUNNER_ID = "runner-other";
const SESSION_ID = "session-1";

function testSession(): AgentSessionDetail {
  const base = {
    agentFile: null,
    autoCompact: true,
    costBasis: "none" as const,
    provider: "openai" as const,
    status: "idle" as const,
  };
  const runningCalls = [
    { arguments: "{}", id: "completed-call", name: "read" },
    { arguments: "{}", id: "call-1", name: "read" },
    { arguments: "{}", id: "call-2", name: "read" },
  ];
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
    activeDurationMs: 0,
    activeStartedAt: null,
    costUsd: 0,
    createdAt: 1,
    credentialId: "credential-1",
    currentContextTokens: 0,
    id: SESSION_ID,
    maxContextTokens: null,
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
    provider: base.provider,
    providerPricing: null,
    reasoningEffort: null,
    runnerId: REMOVED_RUNNER_ID,
    runnerRequired: true,
    status: base.status,
    title: "Session",
    tools: ["read"],
    updatedAt: 2,
    workingDirectory: "/work",
  };
}

function dispatch(
  broker: RunnerCommandBroker,
  runnerId: string,
): Promise<string> {
  return broker.dispatch({
    arguments: {},
    runnerId,
    sessionId: SESSION_ID,
    tool: "read",
    workingDirectory: "/work",
  });
}

function coordinator(
  broker: RunnerCommandBroker,
  appended: { readonly toolCallId: string; readonly toolName: string }[],
  session = testSession(),
  settled: () => Promise<void> = () => Promise.resolve(),
): RunnerRemovalCoordinator {
  return new RunnerRemovalCoordinator({
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
  test("cancels every affected session command and records the unresolved outer call", async () => {
    const ids = ["runner-command-1", "runner-command-2"];
    const broker = new RunnerCommandBroker({
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

    expect(await captureBrokerRejection(removedRunnerCommand)).toMatchObject({
      name: "AbortError",
    });
    expect(await captureBrokerRejection(otherRunnerCommand)).toMatchObject({
      name: "AbortError",
    });
    expect(appended).toEqual([{ toolCallId: "call-1", toolName: "read" }]);
    expect(broker.complete(OTHER_RUNNER_ID, "runner-command-2", "late")).toBe(
      false,
    );
  });

  test("fences commands before waiting for the database removal callback", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "call-1",
      deliver: () => true,
    });
    const command = dispatch(broker, REMOVED_RUNNER_ID);
    let releaseRemoval: (() => void) | undefined;
    const removalBlocked = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const removal = coordinator(
      broker,
      [],
      testSession(),
      () => removalBlocked,
    );
    removal.removing("user-1", REMOVED_RUNNER_ID);
    const removed = removal.removed("user-1", REMOVED_RUNNER_ID);

    expect(broker.complete(REMOVED_RUNNER_ID, "call-1", "late result")).toBe(
      false,
    );
    expect(await captureBrokerRejection(command)).toMatchObject({
      name: "AbortError",
    });
    releaseRemoval?.();
    await removed;
  });
});
