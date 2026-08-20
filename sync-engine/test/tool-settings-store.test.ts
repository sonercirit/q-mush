import { describe, expect, test } from "vitest";
import { toolSettings } from "../../shared/database/schema.ts";
import { TOOL_SETTINGS_PATH } from "../../shared/routes.ts";
import { RealtimeHub } from "../realtime-hub.ts";
import { ToolSettingsStore } from "../tool-settings-store.ts";
import { createToolSettingsIntegration } from "../tool-settings.ts";
import {
  addTestUser,
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  createAuthenticatedTestDatabase,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { RecordingRealtimeSocket } from "./realtime-hub-test-helpers.ts";

function apiSettings(
  executionLimitMinutes: number,
  outputLimitCharacters: number,
) {
  return Object.freeze({ executionLimitMinutes, outputLimitCharacters });
}

function expectStoredSettings(
  store: ToolSettingsStore,
  expected: ReturnType<typeof apiSettings>,
): void {
  expect(store.read(TEST_USER_ID)).toEqual(expected);
}

describe("tool settings store", () => {
  test("returns defaults until a user saves settings", () => {
    const database = createAuthenticatedTestDatabase();
    const store = new ToolSettingsStore(database);
    expect(store.read(TEST_USER_ID)).toEqual(apiSettings(30, 20_000));
    database.$client.close();
  });

  test("persists one audited active row and updates it", () => {
    const database = createAuthenticatedTestDatabase();
    const store = new ToolSettingsStore(database, () => "settings-1");
    const latest = apiSettings(11, 98_765);
    store.set(TEST_USER_ID, apiSettings(9, 12_345), TEST_NOW);
    store.set(TEST_USER_ID, latest, TEST_NOW + 1);

    expectStoredSettings(store, latest);
    const rows = database.select().from(toolSettings).all();
    expect(rows).toMatchObject([
      {
        createdById: TEST_USER_ID,
        executionLimitMinutes: 11,
        id: "settings-1",
        isDeleted: false,
        outputLimitCharacters: 98_765,
        updatedById: TEST_USER_ID,
        userId: TEST_USER_ID,
      },
    ]);
    database.$client.close();
  });

  test("replaces a soft-deleted row with a new active record", () => {
    const database = createAuthenticatedTestDatabase();
    let sequence = 0;
    const store = new ToolSettingsStore(database, () => {
      sequence += 1;
      return `settings-${String(sequence)}`;
    });
    store.set(TEST_USER_ID, apiSettings(4, 4_000), TEST_NOW);
    database.update(toolSettings).set({ isDeleted: true }).run();

    const replacement = apiSettings(8, 8_000);
    store.set(TEST_USER_ID, replacement, TEST_NOW + 1);

    expectStoredSettings(store, replacement);
    const records = database.select().from(toolSettings).all();
    expect(records).toEqual([
      expect.objectContaining({ id: "settings-1", isDeleted: true }),
      expect.objectContaining({ id: "settings-2", isDeleted: false }),
    ]);
    database.$client.close();
  });

  test("isolates settings by user", () => {
    const database = createAuthenticatedTestDatabase();
    addTestUser(database);
    let sequence = 0;
    const generateId = () => {
      sequence += 1;
      return `settings-${String(sequence)}`;
    };
    const store = new ToolSettingsStore(database, generateId);
    store.set(TEST_USER_ID, apiSettings(3, 4_000), TEST_NOW);
    store.set(TEST_FOREIGN_USER_ID, apiSettings(8, 9_000), TEST_NOW);

    expect(store.read(TEST_USER_ID)).toEqual(apiSettings(3, 4_000));
    expect(store.read(TEST_FOREIGN_USER_ID)).toEqual(apiSettings(8, 9_000));
    database.$client.close();
  });
});

function savedSettingsRequest() {
  return createAuthenticatedRequest(
    TOOL_SETTINGS_PATH,
    apiSettings(6, 7_000),
    "PUT",
  );
}

function toolSettingsApi() {
  const context = createAuthenticatedTestContext();
  const integration = createToolSettingsIntegration(context.auth, {
    database: context.database,
  });
  return { ...context, integration };
}

describe("tool settings API", () => {
  test("authenticates, validates, persists, and returns the current settings", async () => {
    const { auth, database } = createAuthenticatedTestContext();
    const integration = createToolSettingsIntegration(auth, {
      database,
      generateId: () => "settings-api",
      now: () => TEST_NOW,
    });

    const defaults = await integration.collection(
      createAuthenticatedRequest(TOOL_SETTINGS_PATH, undefined, "GET"),
    );
    expect(defaults.status).toBe(200);
    const invalid = await integration.collection(
      createAuthenticatedRequest(
        TOOL_SETTINGS_PATH,
        apiSettings(0, 20_000),
        "PUT",
      ),
    );
    expect(invalid.status).toBe(400);
    const saved = await integration.collection(savedSettingsRequest());
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual(apiSettings(6, 7_000));
    expect(integration.store.read(TEST_USER_ID)).toEqual(apiSettings(6, 7_000));
    database.$client.close();
  });

  test("publishes saved settings only through the authenticated user's channel", async () => {
    const { auth, database } = createAuthenticatedTestContext();
    const realtime = new RealtimeHub();
    const owner = new RecordingRealtimeSocket();
    const other = new RecordingRealtimeSocket();
    realtime.setUser(TEST_USER_ID, owner, true, "workspace-1");
    realtime.setUser(TEST_FOREIGN_USER_ID, other, true, "workspace-1");
    const integration = createToolSettingsIntegration(auth, {
      database,
      realtime,
    });

    await integration.collection(savedSettingsRequest());

    expect(owner.messages).toEqual([
      '{"settings":{"executionLimitMinutes":6,"outputLimitCharacters":7000},"type":"tool_settings"}',
    ]);
    expect(other.messages).toEqual([]);
    database.$client.close();
  });

  test("rejects unauthenticated access", async () => {
    const { database, integration } = toolSettingsApi();
    const response = await integration.collection(
      new Request(`http://localhost${TOOL_SETTINGS_PATH}`),
    );
    expect(response.status).toBe(401);
    database.$client.close();
  });
});
