import { expect, test } from "vitest";
import { agentSessionTurns } from "../../shared/database/schema.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { createRunnerCommandBroker} from "../../shared/runner-command-broker.ts";
import type { ToolSettings } from "../../shared/tool-limits.ts";
import { ActiveSessionTools } from "../active-session-tools.ts";
import type { SessionAgentToolActions } from "../session-agent-tools.ts";
import {
  sessionModelRuntime,
  type SessionModelRuntimeResources,
} from "../session-model-runtime.ts";
import { SessionStore } from "../session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  emptyRuntimes,
} from "./session-store-test-fixtures.ts";

const SETTINGS = {
  executionLimitMinutes: 7,
  outputLimitCharacters: 12_345,
} as const;
const UPDATED_SETTINGS = {
  executionLimitMinutes: 9,
  outputLimitCharacters: 54_321,
} as const;

function credential(): ProviderCredentialAccess {
  return {
    accountId: null,
    id: "credential-1",
    isDefault: true,
    label: "Credential",
    secret: "secret",
    source: "api_key",
  };
}

function unusedSessionActions(): SessionAgentToolActions {
  const unused = (): never => {
    throw new Error("unused");
  };
  return {
    browseRunnerDirectories: unused,
    compactSession: unused,
    continueSession: unused,
    getSessionOptions: unused,
    listRunners: unused,
    listSessions: unused,
    readSession: unused,
    reassignSession: unused,
    sendToSession: unused,
    spawnSession: unused,
    steerSession: unused,
    stopSession: unused,
  };
}

interface SettingsStoreSetup extends ReturnType<typeof createStore> {
  readonly store: SessionStore;
}

function configuredStore(read: () => ToolSettings): SettingsStoreSetup {
  const setup = createStore();
  return {
    ...setup,
    store: new SessionStore(
      setup.database,
      setup.generateId,
      read,
      emptyRuntimes,
    ),
  };
}

function closeSetup(setup: SettingsStoreSetup): void {
  setup.database.$client.close();
}

test("persists a fresh snapshot for each user-initiated run", () => {
  let settings: ToolSettings = SETTINGS;
  const setup = configuredStore(() => settings);
  const created = createTestSession(setup.store);

  settings = UPDATED_SETTINGS;
  expect(
    setup.store.transitionRuntime(created.id, "running", TEST_NOW + 1, 0),
  ).toBe(true);
  expect(
    setup.store.transitionRuntime(created.id, "idle", TEST_NOW + 2, 0),
  ).toBe(true);
  expect(setup.store.queue(TEST_USER_ID, created.id, TEST_NOW + 3).status).toBe(
    "queued",
  );

  const turns = setup.database.select().from(agentSessionTurns).all();
  expect(
    turns.map((turn) => ({
      executionLimitMinutes: turn.toolExecutionLimitMinutes,
      outputLimitCharacters: turn.toolOutputLimitCharacters,
    })),
  ).toEqual([SETTINGS, UPDATED_SETTINGS]);
  closeSetup(setup);
});

test("threads the persisted run snapshot into actions", () => {
  const actionSettings: unknown[] = [];
  let settings: ToolSettings = SETTINGS;
  const setup = configuredStore(() => settings);
  const firstDetail = createTestSession(setup.store);
  settings = UPDATED_SETTINGS;
  const secondDetail = createTestSession(setup.store);
  const resources: SessionModelRuntimeResources = {
    actions: {
      actions: (_sessionId, _userId, _generation, snapshot) => {
        actionSettings.push(snapshot);
        return unusedSessionActions();
      },
    },
    braveSearch: { execute: () => Promise.resolve("unused") },
    activeTools: new ActiveSessionTools(),
    broker: createRunnerCommandBroker(),
    modelFactory: () => ({
      complete: () => Promise.reject(new Error("unused")),
    }),
    notify: () => undefined,
    now: Date.now,
    realtime: undefined,
    store: setup.store,
  };

  const runtime = (detail: typeof firstDetail) =>
    sessionModelRuntime(
      resources,
      detail,
      credential(),
      TEST_USER_ID,
      new AbortController(),
    );
  const first = runtime(firstDetail);
  const second = runtime(secondDetail);

  expect(first.toolSettings).toEqual(SETTINGS);
  expect(actionSettings[0]).toBe(first.toolSettings);
  expect(second.toolSettings).toEqual(UPDATED_SETTINGS);
  expect(actionSettings).toEqual([SETTINGS, UPDATED_SETTINGS]);
  closeSetup(setup);
});
