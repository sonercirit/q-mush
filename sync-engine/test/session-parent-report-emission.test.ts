import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { RunnerStore } from "../runner-store.ts";
import { updateStoredSessionProvider } from "../session-provider-update-store.ts";
import { queueStoredSession } from "../session-store-queue.ts";
import { reassignStoredSession } from "../session-store-reassignment.ts";
import type { SessionStoreWriteResources } from "../session-store-resources.ts";
import { updateStoredSessionTools } from "../session-tool-update-store.ts";
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

function expectReported(setup: ReturnType<typeof setupWithReporter>): void {
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

test("tool update emits a terminal child report", () => {
  const { child, setup } = setupWithTerminalChild();
  expect(
    updateStoredSessionTools(setup.resources, {
      now: TEST_NOW + 6,
      sessionId: child.id,
      expectedGeneration: child.generation,
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
      tools: ["read"],
    }).status,
  ).toBe("updated");
  expect(setup.reportParent.mock.calls).toHaveLength(1);
  expectReported(setup);
});

test("tool update preserves an idle child's final parent report", () => {
  const { child, setup } = setupWithTerminalChild();
  setup.database
    .update(agentSessions)
    .set({ status: "idle" })
    .where(eq(agentSessions.id, child.id))
    .run();

  expect(
    updateStoredSessionTools(setup.resources, {
      now: TEST_NOW + 6,
      sessionId: child.id,
      expectedGeneration: child.generation,
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
      tools: ["read"],
    }).status,
  ).toBe("updated");
  expectReported(setup);
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
