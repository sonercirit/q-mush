import { describe, expect, test } from "vitest";
import { WORKSPACES_PATH } from "../../shared/routes.ts";
import { createWorkspaceStore } from "../../sync-engine/workspace-store.ts";
import { createWorkspaceIntegration } from "../../sync-engine/workspaces.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  createTestAuth,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";

const WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000094";

describe("workspace API", () => {
  test("authenticates CRUD and never represents Global as a row", async () => {
    const database = createAuthenticatedTestDatabase();
    const auth = createTestAuth(database);
    const integration = createWorkspaceIntegration({
      auth,
      now: () => TEST_NOW,
      store: createWorkspaceStore(database, () => WORKSPACE_ID),
    });

    expect(
      (
        await integration.collection(
          new Request(`http://localhost${WORKSPACES_PATH}`),
        )
      ).status,
    ).toBe(401);
    const created = await integration.collection(
      createAuthenticatedRequest(WORKSPACES_PATH, { name: "Projects" }, "POST"),
    );
    expect(created.status).toBe(201);
    const list = await integration.collection(
      createAuthenticatedRequest(WORKSPACES_PATH),
    );
    const body: unknown = await list.json();
    expect(JSON.stringify(body)).not.toContain('"Global"');
    expect(JSON.stringify(body)).toContain("Projects");

    const missingOwner = integration.setDefault(
      createAuthenticatedRequest(
        `${WORKSPACES_PATH}/missing/default`,
        undefined,
        "POST",
      ),
      "missing",
    );
    expect(missingOwner.status).toBe(404);
    expect(integration.defaultForUser(TEST_USER_ID)?.name).toBe("Default");
    database.$client.close();
  });

  test("maps operation capacity failures to 507", async () => {
    const database = createAuthenticatedTestDatabase();
    const integration = createWorkspaceIntegration({
      auth: createTestAuth(database),
      now: () => TEST_NOW,
      store: createWorkspaceStore(database, () => WORKSPACE_ID, {
        ownerPartitionOperations: 0,
      }),
    });
    const response = await integration.collection(
      createAuthenticatedRequest(WORKSPACES_PATH, { name: "Full" }, "POST"),
    );
    expect(response.status).toBe(507);
    database.$client.close();
  });
});
