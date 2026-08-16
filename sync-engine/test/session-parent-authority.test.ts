import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import { startManualSessionCompactionForUserId } from "../../sync-engine/session-compaction-actions.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { insertWorkspace } from "../../sync-engine/workspace-write.ts";
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
const FOREIGN_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000099";

interface AuthoritySetup {
  readonly actions: ReturnType<SessionAgentActions["actions"]>;
  readonly close: () => void;
  readonly credentialGate: PromiseGate;
  readonly database: AppDatabase;
  readonly launch: ReturnType<typeof vi.fn>;
  readonly launchOperations: (string | undefined)[];
  readonly metadataGate: PromiseGate;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}

function sessionInput(id: string, runnerId: string, workspaceId?: string) {
  return {
    ...createSessionInput({
      credentialId: CREDENTIAL_ID,
      prompt: `Session ${id}`,
      runnerId,
    }),
    tools: AGENT_SESSION_TOOL_NAMES,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function createStoredSession(
  store: SessionStore,
  id: string,
  runnerId: string,
  workspaceId?: string,
) {
  const detail = requireCreatedSession(
    store.create(sessionInput(id, runnerId, workspaceId), TEST_NOW),
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
  readonly runningTarget?: boolean;
  readonly withTarget?: boolean;
}): AuthoritySetup {
  const database = createAuthenticatedTestDatabase();
  insertWorkspace(database, {
    id: FOREIGN_WORKSPACE_ID,
    name: "Foreign workspace",
    now: TEST_NOW,
    userId: TEST_USER_ID,
  });
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
    if (options.runningTarget !== true) {
      transition(store, target, "idle", TEST_NOW + 2);
    }
  }

  const credentialGate = promiseGate();
  const metadataGate = promiseGate();
  const credential = createTestProviderCredential(CREDENTIAL_ID);

  const launchOperations: (string | undefined)[] = [];
  const launch = vi.fn(
    (
      _credential: unknown,
      _detail: unknown,
      _userId: unknown,
      operation?: string,
    ) => {
      launchOperations.push(operation);
      return true;
    },
  );
  const notify = vi.fn();
  const runtimes = new SessionRuntimes();
  const actions = new SessionAgentActions({
    ...commonActionDependencies(),
    compactSession: startManualSessionCompactionForUserId,
    database,
    discoverSessionMetadata: async () => {
      if (options.gateMetadata === true) {
        await metadataGate.wait();
      }
      return {
        adaptiveThinking: null,
        maxContextTokens: null,
        maxOutputTokens: null,
        providerPricing: null,
      };
    },
    draining: () => false,
    launchSession: launch,
    notify,
    now: () => TEST_NOW + 3,
    readCredential: () => Promise.resolve(credential),
    runtimes,
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
    launchOperations,
    metadataGate,
    notify,
    runtimes,
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
    agentFilePath: null,
    autoCompact: true,
    credentialId: CREDENTIAL_ID,
    idleCompact: false,
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

function expectOnlyParentSession(setup: AuthoritySetup): void {
  expect(setup.store.list(TEST_USER_ID)).toHaveLength(1);
  closeAuthoritySetup(setup);
}

async function expectStaleSpawn(
  gate: PromiseGate,
  setup: AuthoritySetup,
): Promise<void> {
  const result = setup.actions.spawnSession(
    spawnInput(),
    new AbortController().signal,
  );
  await fenceAtGate(gate, setup);
  expect(await result).toContain("parent_stale");
  expectOnlyParentSession(setup);
}

function targetDetail(setup: AuthoritySetup) {
  const target = setup.store.get(TEST_USER_ID, TARGET_SESSION_ID);
  if (target === undefined) {
    throw new Error("Target session not found");
  }
  return target;
}

function closeSetup(setup: AuthoritySetup): void {
  setup.database.$client.close();
}

function setupWithTarget(
  state: "credential" | "idle" | "running",
): AuthoritySetup {
  return authoritySetup({
    ...(state === "credential" ? { gateCredential: true } : {}),
    ...(state === "running" ? { runningTarget: true } : {}),
    withTarget: true,
  });
}

async function expectCompactionScheduled(
  setup: AuthoritySetup,
  sessionId = TARGET_SESSION_ID,
): Promise<void> {
  expect(
    await setup.actions.compactSession(sessionId, new AbortController().signal),
  ).toContain("compaction_scheduled");
}

async function expectCompactionRejected(
  setup: AuthoritySetup,
  sessionId: string,
): Promise<void> {
  await expectCompactionScheduled(setup, sessionId).catch((error: unknown) => {
    expect(error).toHaveProperty("message", "Session not found");
  });
}

function expectTargetUnchanged(
  setup: AuthoritySetup,
  before: ReturnType<SessionStore["get"]>,
): void {
  expect(setup.store.get(TEST_USER_ID, TARGET_SESSION_ID)).toEqual(before);
}

async function expectTargetUnchangedAfterFencing(
  setup: AuthoritySetup,
  gate: PromiseGate,
  before: ReturnType<SessionStore["get"]>,
  result: Promise<string>,
): Promise<void> {
  await Promise.race([gate.entered]);
  fenceParent(setup);
  gate.release(undefined);
  const output = await result;
  expect(output).toContain("parent_stale");
  expectTargetUnchanged(setup, before);
  closeAuthoritySetup(setup);
}

function expectSessionActionThrows(
  action: () => unknown,
  message: string,
): void {
  expect(action).toThrow(message);
}

function activeRuntime(setup: AuthoritySetup) {
  const target = targetDetail(setup);
  const runtime = Promise.withResolvers<undefined>();
  expect(
    setup.runtimes.launch(
      target.id,
      target.runnerId,
      target.generation,
      () => runtime.promise,
    ),
  ).toBe(true);
  return { runtime, target };
}

async function expectPendingCompaction(
  setup: AuthoritySetup,
  target: { readonly generation: number; readonly id: string },
): Promise<void> {
  await expectCompactionScheduled(setup, target.id);
  expect(
    setup.store.manualCompactionPending(target.id, target.generation),
  ).toBe(true);
}

async function expectDeadlineRejection(
  setup: AuthoritySetup,
  gate: PromiseGate,
  deadline: AbortController,
  result: Promise<string>,
): Promise<void> {
  await gate.entered;
  // The global tool limit fired while the gated stage was pending; the
  // caller already reported timed-out, so nothing may mutate or launch.
  deadline.abort(new DOMException("The tool call timed out", "TimeoutError"));
  gate.release(undefined);
  await expect(result).rejects.toThrow("timed out");
  expect(setup.launch).not.toHaveBeenCalled();
}

function targetOperation(
  setup: AuthoritySetup,
  operation: "compact" | "continue" | "send",
  signal: AbortSignal,
): Promise<string> {
  return operation === "compact"
    ? setup.actions.compactSession(TARGET_SESSION_ID, signal)
    : operation === "continue"
      ? setup.actions.continueSession(TARGET_SESSION_ID, signal)
      : setup.actions.sendToSession(TARGET_SESSION_ID, "late message", signal);
}

function credentialCaseSetup(): {
  readonly before: ReturnType<SessionStore["get"]>;
  readonly setup: AuthoritySetup;
} {
  const setup = setupWithTarget("credential");
  return { before: setup.store.get(TEST_USER_ID, TARGET_SESSION_ID), setup };
}

interface ImmediateMutationCase {
  readonly execute: (
    setup: AuthoritySetup,
    signal: AbortSignal,
  ) => Promise<string> | string;
  readonly name: "reassign" | "steer" | "stop";
}

function immediateMutationCases(): readonly ImmediateMutationCase[] {
  return [
    {
      execute: (setup, signal) =>
        setup.actions.steerSession(TARGET_SESSION_ID, "late steering", signal),
      name: "steer",
    },
    {
      execute: (setup, signal) =>
        setup.actions.reassignSession(
          TARGET_SESSION_ID,
          REPLACEMENT_RUNNER_ID,
          "/late/reassignment",
          signal,
        ),
      name: "reassign",
    },
    {
      execute: (setup, signal) =>
        setup.actions.stopSession(TARGET_SESSION_ID, true, signal),
      name: "stop",
    },
  ];
}

function immediateMutationSetup(
  name: ImmediateMutationCase["name"],
): AuthoritySetup {
  const setup = setupWithTarget("running");
  if (name === "reassign") {
    transition(setup.store, targetDetail(setup), "idle", TEST_NOW + 2);
    const reassignmentTarget = setup.database.update(agentSessions);
    reassignmentTarget
      .set({ runnerRequired: true })
      .where(eq(agentSessions.id, TARGET_SESSION_ID))
      .run();
  }
  return setup;
}

describe("cross-session parent execution authority", () => {
  test.each(immediateMutationCases())(
    "rejects canceled $name before mutating the target",
    async ({ execute, name }) => {
      const setup = immediateMutationSetup(name);
      const before = targetDetail(setup);
      const deadline = new AbortController();
      deadline.abort(
        new DOMException("The tool call timed out", "TimeoutError"),
      );

      await expect(
        Promise.resolve().then(() => execute(setup, deadline.signal)),
      ).rejects.toThrow("timed out");
      expectTargetUnchanged(setup, before);
      expect(setup.notify).not.toHaveBeenCalled();
      closeSetup(setup);
    },
  );
  test.each(["compact", "continue", "send"] as const)(
    "rejects credential-paused %s after the parent is fenced",
    async (operation) => {
      const { before, setup } = credentialCaseSetup();
      const result = targetOperation(
        setup,
        operation,
        new AbortController().signal,
      );
      await expectTargetUnchangedAfterFencing(
        setup,
        setup.credentialGate,
        before,
        result,
      );
    },
  );

  test("rejects stale compact and steer actions before mutating the target", () => {
    const setup = setupWithTarget("running");
    const before = setup.store.get(TEST_USER_ID, TARGET_SESSION_ID);
    fenceParent(setup);

    expectSessionActionThrows(
      () =>
        setup.actions.compactSession(
          TARGET_SESSION_ID,
          new AbortController().signal,
        ),
      "stopped",
    );
    expectSessionActionThrows(
      () =>
        setup.actions.steerSession(
          TARGET_SESSION_ID,
          "stale steering",
          new AbortController().signal,
        ),
      "stopped",
    );
    expectTargetUnchanged(setup, before);
    closeAuthoritySetup(setup);
  });

  test("rejects missing and cross-workspace compact or steer targets", async () => {
    const setup = setupWithTarget("running");
    const foreign = createStoredSession(
      setup.store,
      CHILD_SESSION_ID,
      REPLACEMENT_RUNNER_ID,
      FOREIGN_WORKSPACE_ID,
    );

    await expectCompactionRejected(setup, "missing-session");
    expectSessionActionThrows(
      () =>
        setup.actions.steerSession(
          "missing-session",
          "Do not deliver",
          new AbortController().signal,
        ),
      "Session not found",
    );
    await expectCompactionRejected(setup, foreign.id);
    expectSessionActionThrows(
      () =>
        setup.actions.steerSession(
          foreign.id,
          "Do not cross scope",
          new AbortController().signal,
        ),
      "Session not found",
    );
    closeSetup(setup);
  });

  test("idle compaction launches compact-and-continue", async () => {
    const setup = setupWithTarget("idle");

    await expectCompactionScheduled(setup);
    expect(setup.launchOperations).toEqual(["compact_and_continue"]);
    closeSetup(setup);
  });

  test("running compaction schedules once at the next step boundary", async () => {
    const setup = setupWithTarget("running");
    const { runtime, target } = activeRuntime(setup);
    await expectPendingCompaction(setup, target);
    expect(setup.launchOperations).toEqual([]);
    expect(
      await setup.actions.compactSession(
        TARGET_SESSION_ID,
        new AbortController().signal,
      ),
    ).toContain("compaction_already_scheduled");
    expect(
      setup.store.manualCompactionPending(TARGET_SESSION_ID, target.generation),
    ).toBe(true);
    runtime.resolve();
    closeSetup(setup);
  });

  test("steers only a running target and points idle callers to send_to_session", async () => {
    const running = setupWithTarget("running");

    await expect(
      running.actions.steerSession(
        TARGET_SESSION_ID,
        "Change direction",
        new AbortController().signal,
      ),
    ).resolves.toContain("steering_scheduled");
    expect(
      running.store.get(TEST_USER_ID, TARGET_SESSION_ID)?.pendingInputs,
    ).toMatchObject([{ content: "Change direction", kind: "steer" }]);
    closeSetup(running);

    const idle = setupWithTarget("idle");
    expect(() =>
      idle.actions.steerSession(
        TARGET_SESSION_ID,
        "Too late",
        new AbortController().signal,
      ),
    ).toThrow("send_to_session");
    closeSetup(idle);
  });

  test.each(["compact", "continue", "send"] as const)(
    "rejects credential-paused %s after the deadline fires",
    async (operation) => {
      const { before, setup } = credentialCaseSetup();
      const deadline = new AbortController();
      await expectDeadlineRejection(
        setup,
        setup.credentialGate,
        deadline,
        targetOperation(setup, operation, deadline.signal),
      );
      expectTargetUnchanged(setup, before);
      closeAuthoritySetup(setup);
    },
  );

  test("does not create a child when the parent is fenced during credential access", async () => {
    const setup = authoritySetup({ gateCredential: true });
    await expectStaleSpawn(setup.credentialGate, setup);
  });

  test("does not create a child when the parent is fenced during metadata discovery", async () => {
    const setup = authoritySetup({ gateMetadata: true });
    await expectStaleSpawn(setup.metadataGate, setup);
  });

  test("does not create a child when the deadline fires during metadata discovery", async () => {
    const setup = authoritySetup({ gateMetadata: true });
    const deadline = new AbortController();
    await expectDeadlineRejection(
      setup,
      setup.metadataGate,
      deadline,
      setup.actions.spawnSession(spawnInput(), deadline.signal),
    );
    expectOnlyParentSession(setup);
  });
});
