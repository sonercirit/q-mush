import { expect, test, vi } from "vitest";
import { RealtimeCommandError } from "../../shared/user-realtime-protocol.ts";
import { createSessionContextTokenCapAction } from "../session-context-limit-action.ts";
import type { SessionLifecycleDependencies } from "../session-lifecycle-types.ts";
import type { SessionStore } from "../session-store.ts";
import { expectSessionContextTokenCapLifecycle } from "./session-context-limit-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

test("applies and clears an effective context token cap", () => {
  const fixture = createStore();
  createTestSession(fixture.store);
  expectSessionContextTokenCapLifecycle(fixture.store);
  fixture.database.$client.close();
});

test("does not mislabel unexpected store failures as cap validation", () => {
  const failure = new Error("Database unavailable");
  const fixture = createStore();
  const setContextTokenCap = vi
    .spyOn(fixture.store, "setContextTokenCap")
    .mockImplementation(() => {
      throw failure;
    });
  const action = createSessionContextTokenCapAction({
    notify: vi.fn(),
    now: () => 1,
    store: fixture.store,
  } satisfies SessionLifecycleDependencies & { readonly store: SessionStore });
  const user = {
    email: "user@example.test",
    id: "user-1",
    name: "User",
  };

  let caught: unknown;
  try {
    action(user, "session-1", 1, "workspace-1");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(caught).not.toBeInstanceOf(RealtimeCommandError);
  setContextTokenCap.mockRestore();
  fixture.database.$client.close();
});
