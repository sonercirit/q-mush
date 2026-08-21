import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import {
  agentQuestionRequests,
  agentSessions,
} from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { RunnerStore } from "../runner-store.ts";
import { updateStoredSessionProvider } from "../session-provider-update-store.ts";
import { RestartHandoffStore } from "../session-restart-store.ts";
import { ShutdownInterruptedSessionStore } from "../session-shutdown-interrupted-store.ts";
import { queueStoredSession } from "../session-store-queue.ts";
import { reassignStoredSession } from "../session-store-reassignment.ts";
import type { SessionStoreWriteResources } from "../session-store-resources.ts";
import { activeDurableSystemPendingInputs } from "../session-system-pending-inputs.ts";
import { updateStoredSessionTools } from "../session-tool-update-store.ts";
import { testAskQuestionsInput } from "./ask-questions-test-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  addReplacementRunner,
  closeSessionStoreTestSetup,
} from "./session-store-reassignment-helpers.ts";
import { spawnedChildSetup } from "./session-store-spawn-test-helpers.ts";

function setupWithReporter() {
  const setup = spawnedChildSetup();
  const reportParent = vi.fn();
  const resources: SessionStoreWriteResources = {
    database: setup.database,
    generateId: setup.generateId,
    read: (userId, sessionId, workspaceId) =>
      setup.store.get(userId, sessionId, workspaceId),
    reportParent,
    toolSettings: () => DEFAULT_TOOL_SETTINGS,
  };
  return { ...setup, reportParent, resources };
}

function setupWithTerminalChild() {
  const setup = setupWithReporter();
  const child = setup.store.get(TEST_USER_ID, setup.childId);
  if (child === undefined) throw new Error("The terminal child is unavailable");
  expect(child).toMatchObject({
    generation: setup.childGeneration,
    id: setup.childId,
    status: "completed",
  });
  return { child, setup };
}

function setupWithIdleFinalChild() {
  const terminal = setupWithTerminalChild();
  terminal.setup.database
    .update(agentSessions)
    .set({ status: "idle" })
    .where(eq(agentSessions.id, terminal.child.id))
    .run();
  return terminal;
}

function makeChildGenerationTurnActive(
  terminal: ReturnType<typeof setupWithTerminalChild>,
): void {
  terminal.setup.database.$client
    .query(
      "UPDATE agent_session_turns SET execution_generation = ?, ended_at = NULL WHERE session_id = ? AND execution_generation = ?",
    )
    .run(
      terminal.child.generation,
      terminal.child.id,
      terminal.child.generation - 1,
    );
}

function expectReported(setup: ReturnType<typeof setupWithReporter>): void {
  expect(setup.reportParent).toHaveBeenCalledOnce();
  expect(setup.reportParent).toHaveBeenCalledWith(TEST_USER_ID, {
    disposition: "promoted",
    parentId: setup.parentId,
  });
  closeSessionStoreTestSetup(setup);
}

test("queue emits the real terminal-generation parent report", () => {
  const setup = setupWithReporter();
  // Exercise queueStoredSession with resources carrying the callback, rather than
  // SessionStore.queue's intentionally callback-free public continuation path.
  expect(
    queueStoredSession({
      now: TEST_NOW + 6,
      resources: setup.resources,
      sessionId: setup.childId,
      userId: TEST_USER_ID,
    }).status,
  ).toBe("queued");
  expectReported(setup);
});

test("queue preserves an idle child's final parent report", () => {
  const { child, setup } = setupWithIdleFinalChild();
  expect(
    queueStoredSession({
      now: TEST_NOW + 6,
      resources: setup.resources,
      sessionId: child.id,
      userId: TEST_USER_ID,
    }).status,
  ).toBe("queued");
  expectReported(setup);
});

test("reassignment emits a terminal child report", () => {
  const setup = setupWithReporter();
  const replacement = "018bcfe5-6800-7000-8000-000000000099";
  addReplacementRunner(setup.database, replacement);
  const changed = setup.database
    .update(agentSessions)
    .set({ runnerRequired: true, workingDirectory: "/reassigning" })
    .where(eq(agentSessions.id, setup.childId))
    .returning({ id: agentSessions.id })
    .get();
  expect(changed.id).toBe(setup.childId);
  expect(
    reassignStoredSession({
      now: TEST_NOW + 6,
      read: (userId, id) => setup.store.get(userId, id),
      resources: setup.resources,
      runnerId: replacement,
      sessionId: setup.childId,
      userId: TEST_USER_ID,
      workingDirectory: "/tmp",
    }).status,
  ).toBe("reassigned");
  expectReported(setup);
});

test("reassignment preserves an idle child's final parent report", () => {
  const { child, setup } = setupWithIdleFinalChild();
  const replacement = "018bcfe5-6800-7000-8000-000000000098";
  addReplacementRunner(setup.database, replacement);
  setup.database
    .update(agentSessions)
    .set({ runnerRequired: true, workingDirectory: "/reassigning" })
    .where(eq(agentSessions.id, child.id))
    .run();
  expect(
    reassignStoredSession({
      now: TEST_NOW + 6,
      read: (userId, id) => setup.store.get(userId, id),
      resources: setup.resources,
      runnerId: replacement,
      sessionId: child.id,
      userId: TEST_USER_ID,
      workingDirectory: "/tmp",
    }).status,
  ).toBe("reassigned");
  expectReported(setup);
});

test("provider update emits a terminal child report", () => {
  const { child, setup } = setupWithTerminalChild();
  expect(
    updateStoredSessionProvider(setup.resources, {
      adaptiveThinking: child.adaptiveThinking,
      credentialId: child.credentialId,
      expectedGeneration: child.generation,
      maxContextTokens: child.maxContextTokens,
      maxOutputTokens: child.maxOutputTokens,
      now: TEST_NOW + 6,
      openRouterProviderTag: child.openRouterProviderTag,
      provider: child.provider,
      providerPricing: child.providerPricing,
      sessionId: child.id,
      confirmedCacheDrop: true,
      userId: TEST_USER_ID,
      model: `${child.model}-changed`,
      workspaceId: TEST_WORKSPACE_ID,
    }).status,
  ).toBe("updated");
  expect(setup.reportParent).toHaveBeenCalledOnce();
  expectReported(setup);
});

test("provider update preserves an idle child's final parent report", () => {
  const { child, setup } = setupWithIdleFinalChild();
  expect(
    updateStoredSessionProvider(setup.resources, {
      adaptiveThinking: child.adaptiveThinking,
      confirmedCacheDrop: true,
      credentialId: child.credentialId,
      expectedGeneration: child.generation,
      maxContextTokens: child.maxContextTokens,
      maxOutputTokens: child.maxOutputTokens,
      model: `${child.model}-idle-change`,
      now: TEST_NOW + 6,
      openRouterProviderTag: child.openRouterProviderTag,
      provider: child.provider,
      providerPricing: child.providerPricing,
      sessionId: child.id,
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
    }).status,
  ).toBe("updated");
  expectReported(setup);
});

function expectToolUpdateReported(
  terminal: ReturnType<typeof setupWithTerminalChild>,
): void {
  const { child, setup } = terminal;
  const result = updateStoredSessionTools(setup.resources, {
    now: TEST_NOW + 6,
    sessionId: child.id,
    expectedGeneration: child.generation,
    userId: TEST_USER_ID,
    workspaceId: TEST_WORKSPACE_ID,
    tools: ["read"],
  });
  expect(result.status).toBe("updated");
  expectReported(setup);
}

test("tool update emits a terminal child report", () => {
  expectToolUpdateReported(setupWithTerminalChild());
});

test("tool update preserves an idle child's final parent report", () => {
  expectToolUpdateReported(setupWithIdleFinalChild());
});

test("runner removal preserves an idle child's final parent report", () => {
  const { setup } = setupWithIdleFinalChild();
  const runnerId = setup.store.get(TEST_USER_ID, setup.childId)?.runnerId;
  if (runnerId === undefined)
    throw new Error("The child runner is unavailable");
  expect(
    new RunnerStore(
      setup.database,
      setup.generateId,
      undefined,
      setup.reportParent,
    ).remove(TEST_USER_ID, runnerId, TEST_NOW + 6),
  ).toBe(true);
  expectReported(setup);
});

test("restart pause preserves an idle-final generation report", () => {
  const { child, setup } = setupWithIdleFinalChild();
  expect(
    updateStoredSessionTools(setup.resources, {
      expectedGeneration: child.generation,
      now: TEST_NOW + 5,
      sessionId: child.id,
      tools: ["read"],
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
    }).status,
  ).toBe("updated");
  const advancedChild = { ...child, generation: child.generation + 1 };
  makeChildGenerationTurnActive({ child: advancedChild, setup });
  setup.database
    .update(agentSessions)
    .set({ activeStartedAt: new Date(TEST_NOW + 5), status: "running" })
    .where(eq(agentSessions.id, child.id))
    .run();
  const restart = new RestartHandoffStore({
    database: setup.database,
    generateId: setup.generateId,
    read: (userId, id) => setup.store.get(userId, id),
  });
  expect(
    restart.pauseRunning(
      { generation: child.generation + 1, sessionId: child.id },
      "server",
      "parent-report-restart",
      "agent",
      TEST_NOW + 6,
    ),
  ).toBe(true);
  expect(
    activeDurableSystemPendingInputs(setup.database, setup.parentId),
  ).toHaveLength(1);
  closeSessionStoreTestSetup(setup);
});

test("shutdown recovery preserves an idle-final generation report", () => {
  const { child, setup } = setupWithIdleFinalChild();
  expect(
    updateStoredSessionTools(setup.resources, {
      expectedGeneration: child.generation,
      now: TEST_NOW + 5,
      sessionId: child.id,
      tools: ["read"],
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
    }).status,
  ).toBe("updated");
  const advancedChild = { ...child, generation: child.generation + 1 };
  makeChildGenerationTurnActive({ child: advancedChild, setup });
  setup.database
    .update(agentSessions)
    .set({ activeStartedAt: new Date(TEST_NOW + 5), status: "running" })
    .where(eq(agentSessions.id, child.id))
    .run();
  const interrupted = new ShutdownInterruptedSessionStore({
    database: setup.database,
    generateId: setup.generateId,
  });
  expect(
    interrupted.mark(
      child.id,
      child.generation + 1,
      "parent-report-shutdown",
      "agent",
      TEST_NOW + 6,
    ),
  ).toBe(true);
  interrupted.restore(TEST_NOW + 7);
  expect(
    activeDurableSystemPendingInputs(setup.database, setup.parentId),
  ).toHaveLength(1);
  closeSessionStoreTestSetup(setup);
});

test("administrative advance distinguishes pending question ownership and state", () => {
  const scenarios = [
    { answeredAt: null, isDeleted: false, ownSession: true, reports: 0 },
    {
      answeredAt: new Date(TEST_NOW + 5),
      isDeleted: false,
      ownSession: true,
      reports: 1,
    },
    { answeredAt: null, isDeleted: true, ownSession: true, reports: 1 },
    { answeredAt: null, isDeleted: false, ownSession: false, reports: 1 },
  ] as const;
  for (const [index, scenario] of scenarios.entries()) {
    const { child, setup } = setupWithIdleFinalChild();
    setup.database
      .insert(agentQuestionRequests)
      .values({
        ...createdAuditFields(TEST_USER_ID, TEST_NOW + 5),
        answeredAt: scenario.answeredAt,
        executionGeneration: child.generation,
        id: `018bcfe5-6800-7000-8000-0000000001${String(index)}`,
        isDeleted: scenario.isDeleted,
        questions: JSON.stringify(testAskQuestionsInput()),
        sessionId: scenario.ownSession ? child.id : setup.parentId,
        toolCallId: `pending-question-${String(index)}`,
        userId: TEST_USER_ID,
      })
      .run();
    expect(
      updateStoredSessionTools(setup.resources, {
        expectedGeneration: child.generation,
        now: TEST_NOW + 6,
        sessionId: child.id,
        tools: ["read"],
        userId: TEST_USER_ID,
        workspaceId: TEST_WORKSPACE_ID,
      }).status,
    ).toBe("updated");
    expect(setup.reportParent).toHaveBeenCalledTimes(scenario.reports);
    closeSessionStoreTestSetup(setup);
  }
});

test("runner removal emits a terminal child report", () => {
  const setup = setupWithReporter();
  const runnerId = setup.store.get(TEST_USER_ID, setup.childId)?.runnerId;
  if (runnerId === undefined) {
    throw new Error("The child runner is unavailable");
  }
  expect(
    new RunnerStore(
      setup.database,
      setup.generateId,
      undefined,
      setup.reportParent,
    ).remove(TEST_USER_ID, runnerId, TEST_NOW + 6),
  ).toBe(true);
  expectReported(setup);
});
