import { describe, expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
} from "../../shared/agent-loop.ts";
import {
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  completeWokenParent,
  spawnCall,
} from "./session-agent-spawn-helpers.ts";
import { startToolSession } from "./session-agent-tool-setup.ts";
import {
  RUNNER_ID,
  SESSION_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const CHILD_PROMPT = "Keep working until the parent reaches a terminal state.";

type ParentTerminalStatus = "failed" | "idle" | "stopped";

function includesChildPrompt(
  messages: readonly AgentConversationMessage[],
): boolean {
  return messages.some(
    (message) => message.role === "user" && message.content === CHILD_PROMPT,
  );
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted === true) {
    return Promise.reject(
      new DOMException("The session stopped", "AbortError"),
    );
  }
  if (signal === undefined) {
    return promise;
  }
  const aborted = Promise.withResolvers<T>();
  signal.addEventListener(
    "abort",
    () => {
      aborted.reject(new DOMException("The session stopped", "AbortError"));
    },
    { once: true },
  );
  return Promise.race([promise, aborted.promise]);
}

function isSpawnedToolResult(message: AgentConversationMessage): boolean {
  return message.role === "tool" && message.toolName === "spawn_session";
}

interface ParentTerminalWithRunningChildModel extends AgentModel {
  readonly childStarted: PromiseWithResolvers<undefined>;
  readonly parentWaitingPromise: Promise<undefined>;
  finishChild(): void;
  finishParent(outcome: "complete" | "fail"): void;
}

function createParentTerminalWithRunningChildModel(): ParentTerminalWithRunningChildModel {
  const childCompletion = Promise.withResolvers<undefined>();
  const parentCompletion = Promise.withResolvers<"complete" | "fail">();
  const childStarted = Promise.withResolvers<undefined>();
  const parentWaiting = Promise.withResolvers<undefined>();
  let parentRequests = 0;
  return {
    childStarted,
    parentWaitingPromise: parentWaiting.promise,
    finishChild() { childCompletion.resolve(); },
    finishParent(outcome) { parentCompletion.resolve(outcome); },
    async complete(messages, signal) {
      if (includesChildPrompt(messages)) {
        childStarted.resolve();
        await abortable(childCompletion.promise, signal);
        return providerStep("The child completed its delegated work.");
      }
      parentRequests += 1;
      const spawned = messages.some(isSpawnedToolResult);
      if (!spawned) {
        return providerStep("Delegating work before I finish.", {
          toolCalls: [spawnCall(CHILD_PROMPT)],
        });
      }
      parentWaiting.resolve();
      const outcome = await abortable(parentCompletion.promise, signal);
      if (outcome === "fail") throw new Error("Parent failed after spawning its child");
      return providerStep(
        parentRequests === 2
          ? "The parent completed normally."
          : "The parent was unexpectedly resumed by a child callback.",
      );
    },
  };
}

type ChildLifecycleSetup = Awaited<ReturnType<typeof runningChildSetup>>;
type ConnectedSetup = ReturnType<typeof connectedSessionSetup>;

function childFor(setup: ConnectedSetup) {
  return setup.sessions.listForUser(TEST_USER_ID).find((session) => {
    return session.parentSessionId === SESSION_ID;
  });
}

async function runningChildSetup() {
  const model = createParentTerminalWithRunningChildModel();
  const setup = await startToolSession(model);
  await model.parentWaitingPromise;
  const child = childFor(setup);
  if (child === undefined) {
    throw new Error("The spawned child is unavailable");
  }
  const childId = child.id;
  const command = setup.latestRunnerCommand();
  expect(command).toMatchObject({ sessionId: childId });
  const commandId = command?.id ?? "missing";
  const completed = setup.sessions.completeRunnerCommand(RUNNER_ID, commandId, {
    output: "null",
    state: "completed",
  });
  expect(completed).toBe(true);
  await model.childStarted.promise;
  const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
  const runningChild = setup.sessions.detailForUser(TEST_USER_ID, childId);
  expect(parent?.status).toBe("running");
  expect(runningChild?.status).toBe("running");
  return { childId, model, setup };
}

function callbackContentIncludes(
  lifecycle: ChildLifecycleSetup,
  content: string,
): boolean {
  const parent = lifecycle.setup.sessions.detailForUser(
    TEST_USER_ID,
    SESSION_ID,
  );
  return [...(parent?.messages ?? []), ...(parent?.pendingInputs ?? [])].some(
    (message) =>
      message.content.includes("Spawned session") &&
      message.content.includes(content),
  );
}

function childDetail(lifecycle: ChildLifecycleSetup) {
  return lifecycle.setup.sessions.detailForUser(
    TEST_USER_ID,
    lifecycle.childId,
  );
}

async function waitForChildStatus(
  lifecycle: ChildLifecycleSetup,
  status: "completed" | "stopped",
): Promise<void> {
  await waitForSessionValue(
    () => childDetail(lifecycle),
    hasSessionStatus(status),
  );
}

async function waitForCallbackDisposition(
  lifecycle: ChildLifecycleSetup,
): Promise<void> {
  await waitForSessionValue(
    () => callbackContentIncludes(lifecycle, lifecycle.childId),
    (recorded) => recorded === true,
  );
}

function expectCallbackPersisted(
  lifecycle: ChildLifecycleSetup,
  parentStatus: ParentTerminalStatus,
): void {
  const { setup } = lifecycle;
  const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
  const child = childDetail(lifecycle);
  expect(parent).toMatchObject({
    generation: parentStatus === "idle" ? 1 : 0,
    status: parentStatus,
  });
  expect(callbackContentIncludes(lifecycle, lifecycle.childId)).toBe(true);
  expect(child).toMatchObject({
    parentExecutionGeneration: 0,
  });

  expect(
    setup.sessions
      .listForUser(TEST_USER_ID)
      .filter(
        ({ status }) =>
          status === "paused" || status === "queued" || status === "running",
      ),
  ).toEqual([]);
}

async function terminalParent(
  lifecycle: ChildLifecycleSetup,
  status: ParentTerminalStatus,
): Promise<void> {
  await waitForSessionValue(
    () => lifecycle.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    hasSessionStatus(status),
  );
}

async function stoppedChildWithCallback(
  lifecycle: ChildLifecycleSetup,
): Promise<void> {
  await waitForChildStatus(lifecycle, "stopped");
  await waitForCallbackDisposition(lifecycle);
}

async function closeLifecycle(lifecycle: ChildLifecycleSetup): Promise<void> {
  await Bun.sleep(1);
  closeSessionTestDatabase(lifecycle.setup.database);
}

async function completeChildAndConsumeCallback(
  lifecycle: ChildLifecycleSetup,
  parentStatus: ParentTerminalStatus,
): Promise<void> {
  lifecycle.model.finishChild();
  await waitForChildStatus(lifecycle, "completed");
  await waitForCallbackDisposition(lifecycle);
  if (parentStatus === "idle") {
    await completeWokenParent(lifecycle.setup);
  }
  expectCallbackPersisted(lifecycle, parentStatus);
  await closeLifecycle(lifecycle);
}

async function exerciseTerminalParent(
  status: "failed" | "stopped",
): Promise<void> {
  const lifecycle = await runningChildSetup();
  if (status === "failed") {
    lifecycle.model.finishParent("fail");
    await terminalParent(lifecycle, "failed");
  } else {
    await expect(
      lifecycle.setup.sessions.realtimeCommands.stopForUser(
        TEST_AUTHENTICATED_USER,
        SESSION_ID,
        true,
        TEST_WORKSPACE_ID,
      ),
    ).resolves.toMatchObject({ status: "stopped" });
  }
  await stoppedChildWithCallback(lifecycle);
  expectCallbackPersisted(lifecycle, status);
  await closeLifecycle(lifecycle);
}

describe("terminal parents with running children", () => {
  test("a failed parent cascade-stops its child and consumes the callback", async () => {
    await exerciseTerminalParent("failed");
  });

  test("a stopped parent cascade-stops its child and consumes the callback", async () => {
    await exerciseTerminalParent("stopped");
  });

  test("a parent-only stop lets its child finish without delivering a callback", async () => {
    const lifecycle = await runningChildSetup();

    await expect(
      lifecycle.setup.sessions.realtimeCommands.stopForUser(
        TEST_AUTHENTICATED_USER,
        SESSION_ID,
        false,
        TEST_WORKSPACE_ID,
      ),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(childDetail(lifecycle)?.status).toBe("running");

    await completeChildAndConsumeCallback(lifecycle, "stopped");
  });

  test("a completed parent lets its child finish and consumes the callback", async () => {
    const lifecycle = await runningChildSetup();

    lifecycle.model.finishParent("complete");
    await terminalParent(lifecycle, "idle");
    expect(
      lifecycle.setup.sessions.detailForUser(TEST_USER_ID, lifecycle.childId)
        ?.status,
    ).toBe("running");

    await completeChildAndConsumeCallback(lifecycle, "idle");
  });
});
