import { createRunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { SessionAgentActionDependencies } from "../../sync-engine/session-agent-action-helpers.ts";
import type { SessionAgentActionsDependencies } from "../../sync-engine/session-agent-actions-dependencies.ts";
import {
  createTestProviderCredential,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { sessionAgentActionRuntimeDefaults } from "./session-agent-action-runtime-fixtures.ts";

export const EMPTY_SESSION_REQUEST_MODEL_METADATA = {
  adaptiveThinking: null,
  maxContextTokens: null,
  maxOutputTokens: null,
  providerPricing: null,
} as const;

function sessionAgentActionDefaults() {
  const runtimeDefaults = sessionAgentActionRuntimeDefaults();
  return {
    broker: createRunnerCommandBroker(),
    cleanupSession: () => undefined,
    discoverModels: () => Promise.resolve({ defaultModel: null, models: [] }),
    ...runtimeDefaults,
  };
}

export function inactiveSessionAgentActionDefaults() {
  return {
    ...sessionAgentActionDefaults(),
    abortSession: () => undefined,
    activeSession: () => false,
    browseDirectories: () =>
      Promise.resolve({ status: "runner_unavailable" as const }),
    listOnlineRunners: () => [],
  };
}

export function terminalEventActionSetup(
  setup: Readonly<{
    database: SessionAgentActionDependencies["database"];
    store: SessionAgentActionDependencies["store"];
  }>,
  launchSession: SessionAgentActionDependencies["launchSession"],
  notify: SessionAgentActionDependencies["notify"],
): SessionAgentActionsDependencies {
  return {
    ...inactiveSessionAgentActionDefaults(),
    database: setup.database,
    discoverSessionMetadata: () =>
      Promise.resolve(EMPTY_SESSION_REQUEST_MODEL_METADATA),
    launchSession,
    notify,
    now: () => TEST_NOW + 9,
    readCredential: () => Promise.resolve(undefined),
    store: setup.store,
    withCredential: (_userId, selection, action) =>
      Promise.resolve(
        action(
          createTestProviderCredential(selection.credentialId, "api_key", {
            accountId: null,
            secret: "unused",
          }),
        ),
      ),
  };
}

export function spawnedParentReports(
  store: SessionAgentActionDependencies["store"],
  parentId: string,
): readonly string[] {
  const parent = store.get(TEST_USER_ID, parentId);
  const pending = parent?.pendingInputs.map(({ content }) => content) ?? [];
  const messages = parent?.messages.map(({ content }) => content) ?? [];
  return pending.concat(messages);
}

export interface PromiseGate<Value = undefined> {
  readonly entered: Promise<void>;
  readonly promise: Promise<Value>;
  readonly release: (value: Value) => void;
  readonly wait: () => Promise<Value>;
}

export function promiseGate<Value = undefined>(): PromiseGate<Value> {
  const { promise, resolve } = Promise.withResolvers<Value>();
  const entrance = Promise.withResolvers<undefined>();
  return {
    entered: entrance.promise,
    promise,
    release: resolve,
    wait: () => {
      entrance.resolve(undefined);
      return promise;
    },
  };
}
