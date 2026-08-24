import type { AppDatabase } from "../../shared/database.ts";
import {
  createSessionAgentActions,
  type SessionAgentActions,
} from "../../sync-engine/session-agent-actions.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import { inactiveSessionAgentActionDefaults } from "./session-race-test-helpers.ts";
import { restartTestCredential } from "./session-restart-cpd-helpers.ts";

export const CREDENTIAL = restartTestCredential(
  "018bcfe5-6800-7000-8000-000000000042",
  {
    accountId: "provider-account",
    label: "Restart orchestration key",
    secret: "provider-secret",
  },
);

export function orchestrationActions(
  database: AppDatabase,
  store: SessionStore,
): SessionAgentActions {
  const defaults = inactiveSessionAgentActionDefaults();
  return createSessionAgentActions({
    ...defaults,
    database,
    discoverSessionMetadata: () =>
      Promise.resolve(
        Object.assign(
          {},
          {
            adaptiveThinking: null,
            maxContextTokens: 1,
            maxOutputTokens: null,
            providerPricing: null,
          },
        ),
      ),
    launchSession: () => false,
    notify: () => undefined,
    now: () => TEST_NOW + 5,
    readCredential: () => Promise.resolve(void 0),
    store,
    withCredential: () =>
      Promise.resolve().then(() => {
        throw new Error("unused credential");
      }),
  });
}
