import { expect, test, vi } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { compactIdleSessions } from "../session-idle-compaction.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

// The issue contract: idle compaction fires 30 minutes after the agent
// finishes, so one millisecond short must not trigger it.
const IDLE_DELAY_MS = 30 * 60_000;
const DUE_NOW = TEST_NOW + IDLE_DELAY_MS + 1;

type StoreFixture = ReturnType<typeof createStore>;

async function expectDue(
  fixture: StoreFixture,
  count: number,
  now = DUE_NOW,
): Promise<void> {
  await expect(dueSessionCount(fixture, now)).resolves.toBe(count);
}

async function enabledFixture(): Promise<StoreFixture> {
  const fixture = createStore();
  completedSession(fixture, true);
  await expectDue(fixture, 1);
  return fixture;
}

async function dueSessionIds(
  fixture: StoreFixture,
  now = DUE_NOW,
): Promise<readonly string[]> {
  const compacted: string[] = [];
  await compactIdleSessions({
    compact: (userId, sessionId) => {
      expect(userId).toBe(TEST_USER_ID);
      compacted.push(sessionId);
      return Promise.resolve(new Response(null, { status: 202 }));
    },
    database: fixture.database,
    now: () => now,
  });
  return compacted;
}

async function dueSessionCount(
  fixture: StoreFixture,
  now = DUE_NOW,
): Promise<number> {
  const compacted = await dueSessionIds(fixture, now);
  for (const sessionId of compacted) {
    expect(sessionId).toBe(STORE_SESSION_ID);
  }
  return compacted.length;
}

function completedSession(fixture: StoreFixture, idleCompact: boolean) {
  const detail = createTestSession(fixture.store, TEST_NOW, { idleCompact });
  for (const status of ["running", "idle"] as const) {
    expect(
      fixture.store.transitionRuntime(
        detail.id,
        status,
        TEST_NOW,
        detail.generation,
      ),
    ).toBe(true);
  }
  markCompleted(fixture);
  return detail;
}

// Terminal user-visible completion mirrors the agent finishing its run
// with context accumulated on the provider.
function markCompleted(fixture: StoreFixture): void {
  updateSessions(fixture, {
    currentContextTokens: 5_000,
    status: "completed",
    updatedAt: new Date(TEST_NOW),
  });
}

function updateSessions(
  fixture: StoreFixture,
  values: Parameters<ReturnType<StoreFixture["database"]["update"]>["set"]>[0],
): void {
  fixture.database.update(agentSessions).set(values).run();
}

test("compacts only enabled, completed sessions resting past the delay", async () => {
  const fixture = await enabledFixture();

  // Any activity resets the timer through updatedAt, and the full delay
  // must elapse first.
  await expectDue(fixture, 0, TEST_NOW + 1);
  await expectDue(fixture, 0, TEST_NOW + IDLE_DELAY_MS - 1);
  fixture.database.$client.close();
});

test("ignores disabled sessions and non-terminal statuses", async () => {
  const fixture = createStore();
  completedSession(fixture, false);
  await expectDue(fixture, 0);

  updateSessions(fixture, { idleCompact: true, status: "running" });
  for (const status of ["running", "failed", "stopped", "queued"] as const) {
    updateSessions(fixture, { status });
    await expectDue(fixture, 0);
  }

  // Deleted, runner-detached, and restart-pending sessions never qualify.
  updateSessions(fixture, { status: "completed" });
  await expectDue(fixture, 1);
  updateSessions(fixture, { isDeleted: true });
  await expectDue(fixture, 0);
  updateSessions(fixture, { isDeleted: false, runnerRequired: true });
  await expectDue(fixture, 0);
  updateSessions(fixture, {
    restartHandoff: "handoff",
    runnerRequired: false,
  });
  await expectDue(fixture, 0);
  updateSessions(fixture, { restartHandoff: null });

  // Idle sessions qualify, but only with uncompacted context: compaction
  // zeroes the tracked tokens, so a compacted session cannot loop.
  updateSessions(fixture, { status: "idle" });
  await expectDue(fixture, 1);
  updateSessions(fixture, { currentContextTokens: 0 });
  await expectDue(fixture, 0);
  fixture.database.$client.close();
});

test("continues the batch when a candidate fails and retries next scan", async () => {
  const fixture = await enabledFixture();
  const second = createTestSession(fixture.store, TEST_NOW, {
    idleCompact: true,
  });
  expect(second.id).not.toBe(STORE_SESSION_ID);
  markCompleted(fixture);
  const compact = vi
    .fn<(userId: string, sessionId: string) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("credential missing"))
    .mockResolvedValue(new Response(null, { status: 202 }));
  const scan = () =>
    compactIdleSessions({
      compact,
      database: fixture.database,
      now: () => DUE_NOW,
    });

  // The first candidate's rejection must not abort the batch: the second
  // candidate still compacts in the same scan.
  await scan();
  expect(compact).toHaveBeenCalledTimes(2);
  expect(compact).toHaveBeenNthCalledWith(1, TEST_USER_ID, STORE_SESSION_ID);
  expect(compact).toHaveBeenNthCalledWith(2, TEST_USER_ID, second.id);

  // The rejected attempt marked nothing durable; the next scan retries both.
  await scan();
  expect(compact).toHaveBeenCalledTimes(4);
  fixture.database.$client.close();
});

test("never rejects even when the candidate query fails", async () => {
  const fixture = await enabledFixture();
  fixture.database.$client.close();

  // The scan is fire-and-forget from the liveness interval: a closed or
  // failing database must resolve quietly, not become a fatal unhandled
  // rejection.
  await expect(dueSessionIds(fixture)).resolves.toEqual([]);
});
