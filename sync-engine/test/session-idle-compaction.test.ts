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

async function dueSessionCount(
  fixture: StoreFixture,
  now = DUE_NOW,
): Promise<number> {
  const compacted: (readonly [string, string])[] = [];
  await compactIdleSessions({
    compact: (userId, sessionId) => {
      compacted.push([userId, sessionId]);
      return Promise.resolve(new Response(null, { status: 202 }));
    },
    database: fixture.database,
    now: () => now,
  });
  for (const [userId, sessionId] of compacted) {
    expect(userId).toBe(TEST_USER_ID);
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
  // Terminal user-visible completion mirrors the agent finishing its run
  // with context accumulated on the provider.
  updateSessions(fixture, {
    currentContextTokens: 5_000,
    status: "completed",
    updatedAt: new Date(TEST_NOW),
  });
  return detail;
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

  // Idle sessions qualify, but only with uncompacted context: compaction
  // zeroes the tracked tokens, so a compacted session cannot loop.
  updateSessions(fixture, { status: "idle" });
  await expectDue(fixture, 1);
  updateSessions(fixture, { currentContextTokens: 0 });
  await expectDue(fixture, 0);
  fixture.database.$client.close();
});

test("compacts every due session and survives per-session failures", async () => {
  const fixture = await enabledFixture();
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

  await scan();
  expect(compact).toHaveBeenCalledWith(TEST_USER_ID, STORE_SESSION_ID);

  // The rejected attempt did not mark anything; the next scan retries.
  await scan();
  expect(compact).toHaveBeenCalledTimes(2);
  fixture.database.$client.close();
});
