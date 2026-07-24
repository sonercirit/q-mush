import { describe, expect, test } from "vitest";
import { WORKSPACES_PATH } from "../../shared/routes.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { WorkspaceStore } from "../../sync-engine/workspace-store.ts";
import { createWorkspaceIntegration } from "../../sync-engine/workspaces.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";

const WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000094";

describe("workspace API", () => {
  test("authenticates CRUD and never represents Global as a row", async () => {
    const database = createAuthenticatedTestDatabase();
    const auth = createGoogleAuthFromEnvironment(
      {},
      {
        database,
        now: () => TEST_NOW,
      },
    );
    const integration = createWorkspaceIntegration({
      auth,
      now: () => TEST_NOW,
      store: new WorkspaceStore(database, () => WORKSPACE_ID),
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
});
