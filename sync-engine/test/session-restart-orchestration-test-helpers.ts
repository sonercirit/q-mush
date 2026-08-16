import type { AppDatabase } from "../../shared/database.ts";
import { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import { sessionAgentActionDefaults } from "./session-race-test-helpers.ts";
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
  const defaults = sessionAgentActionDefaults();
  return new SessionAgentActions({
    ...defaults,
    abortSession: () => undefined,
    activeSession: () => false,
    browseDirectories: () =>
      Promise.resolve(
        Object.assign({}, { status: "runner_unavailable" as const }),
      ),
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
    listOnlineRunners: () => [],
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
