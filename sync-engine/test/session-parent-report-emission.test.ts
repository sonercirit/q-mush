import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import {
  agentQuestionRequests,
  agentSessions,
} from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { createRunnerStore } from "../runner-store.ts";
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
import {
  spawnedChildSetup,
  terminalRecordedMessage,
} from "./session-store-spawn-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

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

type ChildSetup = ReturnType<typeof setupWithTerminalChild>;

function testReportedGenerationVariants(
  name: string,
  exercise: (terminal: ChildSetup, variant: "terminal" | "idle final") => void,
): void {
  test.each([
    ["terminal", setupWithTerminalChild],
    ["idle final", setupWithIdleFinalChild],
  ] as const)(
    `${name} preserves a %s child parent report`,
    (variant, setup) => {
      const terminal = setup();
      exercise(terminal, variant);
      expectReported(terminal.setup);
    },
  );
}

function expectStatus(
  result: { status: string },
  expected: "queued" | "reassigned" | "updated",
): void {
  expect(result.status).toBe(expected);
}

testReportedGenerationVariants("queue", ({ child, setup }) => {
  // Exercise queueStoredSession with resources carrying the callback, rather than
  // SessionStore.queue's intentionally callback-free public continuation path.
  expectStatus(
    queueStoredSession({
      now: TEST_NOW + 6,
      resources: setup.resources,
      sessionId: child.id,
      userId: TEST_USER_ID,
    }),
    "queued",
  );
});

testReportedGenerationVariants("reassignment", ({ child, setup }, variant) => {
  const replacement =
    variant === "terminal"
      ? "018bcfe5-6800-7000-8000-000000000099"
      : "018bcfe5-6800-7000-8000-000000000098";
  addReplacementRunner(setup.database, replacement);
  const changed = setup.database
    .update(agentSessions)
    .set({ runnerRequired: true, workingDirectory: "/reassigning" })
    .where(eq(agentSessions.id, child.id))
    .returning({ id: agentSessions.id })
    .get();
  expect(changed.id).toBe(child.id);
  expectStatus(
    reassignStoredSession({
      now: TEST_NOW + 6,
      read: (userId, id) => setup.store.get(userId, id),
      resources: setup.resources,
      runnerId: replacement,
      sessionId: child.id,
      userId: TEST_USER_ID,
      workingDirectory: "/tmp",
    }),
    "reassigned",
  );
});

testReportedGenerationVariants(
  "provider update",
  ({ child, setup }, variant) => {
    expectStatus(
      updateStoredSessionProvider(setup.resources, {
        adaptiveThinking: child.adaptiveThinking,
        confirmedCacheDrop: true,
        credentialId: child.credentialId,
        expectedGeneration: child.generation,
        maxContextTokens: child.maxContextTokens,
        maxOutputTokens: child.maxOutputTokens,
        model: `${child.model}-${variant}-change`,
        now: TEST_NOW + 6,
        openRouterProviderTag: child.openRouterProviderTag,
        provider: child.provider,
        providerPricing: child.providerPricing,
        sessionId: child.id,
        userId: TEST_USER_ID,
        workspaceId: TEST_WORKSPACE_ID,
      }),
      "updated",
    );
  },
);

function expectToolUpdateReported(
  terminal: ChildSetup,
  now = TEST_NOW + 6,
): void {
  const { child, setup } = terminal;
  const result = updateStoredSessionTools(setup.resources, {
    now,
    sessionId: child.id,
    expectedGeneration: child.generation,
    userId: TEST_USER_ID,
    workspaceId: TEST_WORKSPACE_ID,
    tools: ["read"],
  });
  expect(result.status).toBe("updated");
}

testReportedGenerationVariants("tool update", (terminal) => {
  expectToolUpdateReported(terminal);
});

testReportedGenerationVariants("runner removal", ({ setup }) => {
  const runnerId = setup.store.get(TEST_USER_ID, setup.childId)?.runnerId;
  if (runnerId === undefined)
    throw new Error("The child runner is unavailable");
  expect(
    createRunnerStore(
      setup.database,
      setup.generateId,
      undefined,
      setup.reportParent,
    ).remove(TEST_USER_ID, runnerId, TEST_NOW + 6),
  ).toBe(true);
});

function startCurrent(
  setup: ReturnType<typeof createStore>,
  sessionId: string,
  now: number,
): void {
  expect(setup.store.transitionCurrent(sessionId, "running", now)).toBe(true);
}

test("runner removal fences a three-level lineage descendants first", () => {
  const setup = createStore();
  const reportParent = vi.fn();
  const parent = createTestSession(setup.store);
  startCurrent(setup, parent.id, TEST_NOW + 1);
  const childInput = {
    parentGeneration: parent.generation,
    parentSessionId: parent.id,
  };
  const child = createTestSession(setup.store, TEST_NOW + 2, childInput);
  startCurrent(setup, child.id, TEST_NOW + 3);
  const grandchild = createTestSession(setup.store, TEST_NOW + 4, {
    parentGeneration: child.generation,
    parentSessionId: child.id,
  });
  startCurrent(setup, grandchild.id, TEST_NOW + 5);
  setup.store.commitRuntimeTerminal(
    grandchild.id,
    [terminalRecordedMessage("Grandchild terminal response")],
    TEST_NOW + 6,
    grandchild.generation,
    null,
  );
  const runnerId = setup.store.get(TEST_USER_ID, grandchild.id)?.runnerId;
  if (runnerId === undefined) throw new Error("The runner is unavailable");
  expect(
    createRunnerStore(
      setup.database,
      setup.generateId,
      undefined,
      reportParent,
    ).remove(TEST_USER_ID, runnerId, TEST_NOW + 7),
  ).toBe(true);
  expect(reportParent).toHaveBeenCalledOnce();
  expect(reportParent).toHaveBeenCalledWith(TEST_USER_ID, {
    disposition: "promoted",
    parentId: child.id,
  });
  closeSessionStoreTestSetup(setup);
});

function setupAdvancedRunningChild(): ChildSetup {
  const terminal = setupWithIdleFinalChild();
  expectToolUpdateReported(terminal, TEST_NOW + 5);
  const { child, setup } = terminal;
  makeChildGenerationTurnActive({
    child: { ...child, generation: child.generation + 1 },
    setup,
  });
  setup.database
    .update(agentSessions)
    .set({ activeStartedAt: new Date(TEST_NOW + 5), status: "running" })
    .where(eq(agentSessions.id, child.id))
    .run();
  return terminal;
}

function expectPendingParentReport(
  setup: ReturnType<typeof setupWithReporter>,
): void {
  expect(
    activeDurableSystemPendingInputs(setup.database, setup.parentId),
  ).toHaveLength(1);
  closeSessionStoreTestSetup(setup);
}

test("restart pause preserves an idle-final generation report", () => {
  const { child, setup } = setupAdvancedRunningChild();
  const restart = RestartHandoffStore({
    database: setup.database,
    generateId: setup.generateId,
    read: (userId, sessionId) =>
      setup.store.get(userId, sessionId, TEST_WORKSPACE_ID),
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
  expectPendingParentReport(setup);
});

test("shutdown recovery preserves an idle-final generation report", () => {
  const { child, setup } = setupAdvancedRunningChild();
  const interrupted = ShutdownInterruptedSessionStore({
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
  expectPendingParentReport(setup);
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
    expectToolUpdateReported({ child, setup });
    expect(setup.reportParent).toHaveBeenCalledTimes(scenario.reports);
    closeSessionStoreTestSetup(setup);
  }
});
