import { describe, expect, test, vi } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  createTestProviderCredential,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  CREDENTIAL_ID,
  REPLACEMENT_RUNNER_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  promiseGate,
  sessionAgentActionDefaults,
  type PromiseGate,
} from "./session-race-test-helpers.ts";
import { createSessionInput } from "./session-store-create-hardening-helpers.ts";
import { requireCreatedSession } from "./session-store-result-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";

const TARGET_SESSION_ID = "018bcfe5-6800-7000-8000-000000000090";
const CHILD_SESSION_ID = "018bcfe5-6800-7000-8000-000000000092";

interface AuthoritySetup {
  readonly actions: ReturnType<SessionAgentActions["actions"]>;
  readonly close: () => void;
  readonly credentialGate: PromiseGate;
  readonly database: AppDatabase;
  readonly launch: ReturnType<typeof vi.fn>;
  readonly metadataGate: PromiseGate;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly store: SessionStore;
}

function sessionInput(id: string, runnerId: string) {
  return {
    ...createSessionInput({
      credentialId: CREDENTIAL_ID,
      prompt: `Session ${id}`,
      runnerId,
    }),
    tools: AGENT_SESSION_TOOL_NAMES,
  };
}

function createStoredSession(
  store: SessionStore,
  id: string,
  runnerId: string,
) {
  const detail = requireCreatedSession(
    store.create(sessionInput(id, runnerId), TEST_NOW),
  );
  expect(detail.id).toBe(id);
  return detail;
}

function transition(
  store: SessionStore,
  session: { readonly generation: number; readonly id: string },
  status: "idle" | "running",
  now: number,
): void {
  expect(
    store.transitionRuntime(session.id, status, now, session.generation),
  ).toBe(true);
}

function commonActionDependencies() {
  return {
    ...sessionAgentActionDefaults(),
    abortSession: vi.fn(),
    activeSession: () => false,
    browseDirectories: () =>
      Promise.resolve({ status: "runner_unavailable" as const }),
    cleanupSession: () => undefined,
    listOnlineRunners: () => [],
  };
}

function authoritySetup(options: {
  readonly gateCredential?: boolean;
  readonly gateMetadata?: boolean;
  readonly withTarget?: boolean;
}): AuthoritySetup {
  const database = createAuthenticatedTestDatabase();
  addSessionTestRunner(database, "parent-authority-runner", RUNNER_ID);
  addSessionTestRunner(
    database,
    "target-authority-runner",
    REPLACEMENT_RUNNER_ID,
  );
  addTestProviderCredential(database, CREDENTIAL_ID);
  const ids = [
    SESSION_ID,
    "parent-authority-message",
    TARGET_SESSION_ID,
    "target-authority-message",
    CHILD_SESSION_ID,
    "child-authority-message",
  ];
  const store = new SessionStore(
    database,
    () => ids.shift() ?? "unexpected-parent-authority-id",
  );
  const parent = createStoredSession(store, SESSION_ID, RUNNER_ID);
  transition(store, parent, "running", TEST_NOW + 1);
  if (options.withTarget === true) {
    const target = createStoredSession(
      store,
      TARGET_SESSION_ID,
      REPLACEMENT_RUNNER_ID,
    );
    transition(store, target, "running", TEST_NOW + 1);
    transition(store, target, "idle", TEST_NOW + 2);
  }

  const credentialGate = promiseGate();
  const metadataGate = promiseGate();
  const credential = createTestProviderCredential(CREDENTIAL_ID);

  const launch = vi.fn(() => true);
  const notify = vi.fn();
  const actions = new SessionAgentActions({
    ...commonActionDependencies(),
    database,
    discoverSessionMetadata: async () => {
      if (options.gateMetadata === true) {
        await metadataGate.wait();
      }
      return { maxContextTokens: null, providerPricing: null };
    },
    draining: () => false,
    launchSession: launch,
    notify,
    now: () => TEST_NOW + 3,
    readCredential: () => Promise.resolve(credential),
    store,
    withCredential: async (_userId, _selection, action) => {
      if (options.gateCredential === true) {
        await credentialGate.wait();
      }
      return action(credential);
    },
  }).actions(
    SESSION_ID,
    TEST_USER_ID,
    parent.generation,
    new AbortController().signal,
  );

  return {
    actions,
    close: () => {
      database.$client.close();
    },
    credentialGate,
    database,
    launch,
    metadataGate,
    notify,
    store,
  };
}

function fenceParent(setup: AuthoritySetup): void {
  expect(
    new RunnerStore(setup.database).remove(
      TEST_USER_ID,
      RUNNER_ID,
      TEST_NOW + 3,
    ),
  ).toBe(true);
}

function spawnInput() {
  return {
    autoCompact: true,
    credentialId: CREDENTIAL_ID,
    executionEnvironment: "bare_metal" as const,
    images: [],
    model: "gpt-4.1-mini",
    openRouterProviderTag: null,
    prompt: "Stale child must not be created",
    provider: "openai" as const,
    reasoningEffort: null,
    runnerId: REPLACEMENT_RUNNER_ID,
    tools: [],
    workingDirectory: "/work/child",
  };
}

function expectNoSideEffects(setup: AuthoritySetup): void {
  expect(setup.launch).not.toHaveBeenCalled();
  expect(setup.notify).not.toHaveBeenCalled();
}

function closeAuthoritySetup(setup: AuthoritySetup): void {
  expectNoSideEffects(setup);
  setup.close();
}

async function fenceAtGate(
  gate: PromiseGate,
  setup: AuthoritySetup,
): Promise<void> {
  await gate.entered;
  fenceParent(setup);
  gate.release(undefined);
}

async function expectParentStale(result: Promise<string>): Promise<void> {
  expect(await result).toContain("parent_stale");
}

async function expectStaleSpawn(
  gate: PromiseGate,
  setup: AuthoritySetup,
  result: Promise<string>,
): Promise<void> {
  await fenceAtGate(gate, setup);
  await expectParentStale(result);
  expect(setup.store.list(TEST_USER_ID)).toHaveLength(1);
  closeAuthoritySetup(setup);
}

describe("cross-session parent execution authority", () => {
  test.each(["continue", "send"] as const)(
    "rejects credential-paused %s after the parent is fenced",
    async (operation) => {
      const setup = authoritySetup({ gateCredential: true, withTarget: true });
      const before = setup.store.get(TEST_USER_ID, TARGET_SESSION_ID);
      const result =
        operation === "continue"
          ? setup.actions.continueSession(TARGET_SESSION_ID)
          : setup.actions.sendToSession(TARGET_SESSION_ID, "stale message");
      await fenceAtGate(setup.credentialGate, setup);
      await expectParentStale(result);

      expect(setup.store.get(TEST_USER_ID, TARGET_SESSION_ID)).toEqual(before);
      closeAuthoritySetup(setup);
    },
  );

  test("does not create a child when the parent is fenced during credential access", async () => {
    const setup = authoritySetup({ gateCredential: true });
    await expectStaleSpawn(
      setup.credentialGate,
      setup,
      setup.actions.spawnSession(spawnInput()),
    );
  });

  test("does not create a child when the parent is fenced during metadata discovery", async () => {
    const setup = authoritySetup({ gateMetadata: true });
    await expectStaleSpawn(
      setup.metadataGate,
      setup,
      setup.actions.spawnSession(spawnInput()),
    );
  });
});
