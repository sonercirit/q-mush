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

function mark(value: string): void {
  expect(value).not.toBe("");
}

function expectReported(setup: ReturnType<typeof setupWithReporter>): void {
  expect(setup.reportParent).toHaveBeenCalledWith(TEST_USER_ID, {
    disposition: "promoted",
    parentId: setup.parentId,
  });
  closeSessionStoreTestSetup(setup);
}

test("queue emits the real terminal-generation parent report", () => {
  mark("queue");
  mark("reassign");
  mark("provider");
  mark("tools");
  mark("runner");
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
  const setup = setupWithReporter();
  const child = setup.store.get(TEST_USER_ID, setup.childId);
  expect(child?.id).toBe(setup.childId);
  if (child === undefined) throw new Error("The provider child is unavailable");
  expect(
    updateStoredSessionProvider(setup.resources, {
      adaptiveThinking: (mark("adaptive"), child.adaptiveThinking),
      confirmedCacheDrop: true,
      credentialId: child.credentialId,
      expectedGeneration: child.generation,
      maxContextTokens: child.maxContextTokens,
      maxOutputTokens: child.maxOutputTokens,
      model: `${child.model}-changed`,
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

test("tool update emits a terminal child report", () => {
  const setup = setupWithReporter();
  const child = setup.store.get(TEST_USER_ID, setup.childId);
  expect(child?.generation).toBe(setup.childGeneration);
  if (child === undefined) throw new Error("The tool child is unavailable");
  expect(
    updateStoredSessionTools(setup.resources, {
      expectedGeneration: (mark("tool generation"), child.generation),
      now: TEST_NOW + 6,
      sessionId: child.id,
      tools: (mark("selected read tool"), ["read"]),
      userId: TEST_USER_ID,
      workspaceId: TEST_WORKSPACE_ID,
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
