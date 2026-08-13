import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { sessionTimingUpdate } from "../session-store-persistence.ts";
import type { SessionStore } from "../session-store.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

const SESSION_ID = STORE_SESSION_ID;
const NOW = 1_700_000_000_000;

function runningStoreWithStep(stepStartedAt: number) {
  const setup = runningStore();
  markStepStart(setup.store, stepStartedAt);
  return setup;
}

function markStepStart(store: SessionStore, now: number): void {
  const detail = store.get(TEST_USER_ID, SESSION_ID);
  if (detail === undefined) throw new Error("The session is missing");
  store.markRuntimeStepStart(SESSION_ID, now, detail.generation);
}

function storedStepStartedAt(store: SessionStore): number | null | undefined {
  return store.get(TEST_USER_ID, SESSION_ID)?.stepStartedAt;
}

// Plants a stale step start directly so a path's own defensive clear stays
// load-bearing even when earlier transitions already cleared the column.
function plantStaleStepStart(
  setup: ReturnType<typeof createStore>,
  at: number,
): void {
  setup.database
    .update(agentSessions)
    .set({ stepStartedAt: new Date(at) })
    .where(eq(agentSessions.id, SESSION_ID))
    .run();
  expect(storedStepStartedAt(setup.store)).toBe(at);
}

function stopSession(store: SessionStore): boolean {
  return store.stop(TEST_USER_ID, SESSION_ID, NOW + 20);
}

describe("session step start persistence", () => {
  test("marking a step start persists its timestamp on the running session", () => {
    const { store } = runningStoreWithStep(NOW + 10);

    expect(storedStepStartedAt(store)).toBe(NOW + 10);

    markStepStart(store, NOW + 25);

    expect(storedStepStartedAt(store)).toBe(NOW + 25);
  });

  test("a created session has no step start", () => {
    const { store } = createStore();
    const created = createTestSession(store);

    expect(created.stepStartedAt).toBeNull();
    expect(
      store.list(TEST_USER_ID).find(({ id }) => id === SESSION_ID)
        ?.stepStartedAt,
    ).toBeNull();
  });

  test.each([
    [
      "completes",
      (store: SessionStore) =>
        store.transitionCurrent(SESSION_ID, "idle", NOW + 20),
    ],
    [
      "fails",
      (store: SessionStore) =>
        store.transitionCurrent(SESSION_ID, "failed", NOW + 20),
    ],
    ["is stopped", stopSession],
  ])("clears the step start when the run %s", (_label, finish) => {
    const { store } = runningStoreWithStep(NOW + 10);

    expect(finish(store)).toBe(true);

    const detail = store.get(TEST_USER_ID, SESSION_ID);
    expect(detail?.activeStartedAt).toBeNull();
    expect(detail?.stepStartedAt).toBeNull();
  });

  test("the shared timing update clears the step start with the run", () => {
    // Every settling call site (transitions, restarts, provider/tool
    // updates, pending inputs) routes through this helper; the next timing
    // column must not be forgettable here.
    expect(
      sessionTimingUpdate(
        { activeDurationMs: 5, activeStartedAt: NOW },
        NOW + 10,
      ),
    ).toEqual({
      activeDurationMs: 15,
      activeStartedAt: null,
      stepStartedAt: null,
    });
  });

  test.each([
    ["stopping a queued session", stopSession, undefined],
    [
      "launching a queued session",
      (store: SessionStore) =>
        store.transitionCurrent(SESSION_ID, "running", NOW + 20),
      NOW + 20,
    ],
  ] as const)(
    "%s clears a stale planted step start defensively",
    (_label, transition, activeStartedAt) => {
      const setup = createStore();
      createTestSession(setup.store);
      // A queued session never gets a runtime step-start write.
      plantStaleStepStart(setup, NOW + 5);

      expect(transition(setup.store)).toBe(true);

      const detail = setup.store.get(TEST_USER_ID, SESSION_ID);
      expect(detail?.stepStartedAt).toBeNull();
      expect(detail?.activeStartedAt).toBe(activeStartedAt ?? null);
    },
  );

  test("requeueing a finished session leaves no stale step start", () => {
    const setup = runningStoreWithStep(NOW + 10);
    const { store } = setup;
    expect(store.transitionCurrent(SESSION_ID, "idle", NOW + 20)).toBe(true);
    // The idle transition already cleared the step start.
    plantStaleStepStart(setup, NOW + 25);

    const queued = store.queue(TEST_USER_ID, SESSION_ID, NOW + 30, {
      content: "Follow up",
      images: [],
    });

    expect(queued).not.toBeUndefined();
    expect(storedStepStartedAt(store)).toBeNull();
  });
});
