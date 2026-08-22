import { expect, test } from "vitest";
import { storedSessionResponse } from "../session-workspace.ts";
import {
  TEST_FOREIGN_USER_ID,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

function createIdentityResponse(
  store: ReturnType<typeof createStore>["store"],
  detail: ReturnType<typeof createTestSession>,
  ownerId: string,
): Response {
  return storedSessionResponse(store, ownerId, detail.id, detail.workspaceId);
}

test("session IDs remain confined to owner detail and list snapshots", async () => {
  const setup = createStore();
  const detail = createTestSession(setup.store, 1_700_000_000_001);

  const owned = createIdentityResponse(setup.store, detail, TEST_USER_ID);
  const foreign = createIdentityResponse(
    setup.store,
    detail,
    TEST_FOREIGN_USER_ID,
  );

  expect(await owned.json()).toMatchObject({ id: detail.id });
  const ownerSnapshotIds = setup.store
    .list(TEST_USER_ID)
    .map((session) => session.id);
  const foreignSnapshot = setup.store.list(TEST_FOREIGN_USER_ID);
  expect({ foreignSnapshot, ownerSnapshotIds }).toEqual({
    foreignSnapshot: [],
    ownerSnapshotIds: [detail.id],
  });
  expect(foreign.status).toBe(404);
  expect(await foreign.text()).not.toContain(detail.id);
  setup.database.$client.close();
});
