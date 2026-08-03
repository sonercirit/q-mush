import { expect } from "vitest";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

export function expectSessionContextTokenCapLifecycle(
  store: SessionStore,
): void {
  const capped = store.setContextTokenCap(
    TEST_USER_ID,
    STORE_SESSION_ID,
    120_000,
    TEST_NOW + 1,
  );
  expect(capped).toMatchObject({
    maxContextTokens: 120_000,
    userContextTokenCap: 120_000,
  });
  expect(() =>
    store.setContextTokenCap(
      TEST_USER_ID,
      STORE_SESSION_ID,
      200_001,
      TEST_NOW + 2,
    ),
  ).toThrow("cannot exceed the model limit");
  expect(
    store.setContextTokenCap(
      TEST_USER_ID,
      STORE_SESSION_ID,
      null,
      TEST_NOW + 3,
    ),
  ).toMatchObject({
    maxContextTokens: 200_000,
    userContextTokenCap: null,
  });
}
