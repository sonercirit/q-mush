import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { ModelCredentialPool } from "../../sync-engine/model-credential-pool.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import {
  createSessionAgentActions,
  type SessionAgentActions,
} from "../../sync-engine/session-agent-actions.ts";
import { startManualSessionCompactionForUserId } from "../../sync-engine/session-compaction-actions.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { createSessionStore, type SessionStore } from "../../sync-engine/session-store.ts";
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
  inactiveSessionAgentActionDefaults,
  promiseGate,
  type PromiseGate,
} from "./session-race-test-helpers.ts";
import { createSessionInput } from "./session-store-create-hardening-helpers.ts";
import { requireCreatedSession } from "./session-store-result-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";
import { emptyRuntimes } from "./session-store-test-fixtures.ts";

class RejectingModelCredentialPool extends ModelCredentialPool {
  override candidates(): Promise<never> {
    return Promise.reject(new Error("candidate boom"));
  }
}

export const TARGET_SESSION_ID = "018bcfe5-6800-7000-8000-000000000090";
export const CHILD_SESSION_ID = "018bcfe5-6800-7000-8000-000000000092";
export const FOREIGN_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000099";

export interface AuthoritySetup {
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

export function createStoredSession(
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

export function authoritySetup(options: {
  readonly fenceOnNotify?: boolean;
  readonly gateCredential?: boolean;
  readonly gateMetadata?: boolean;
  readonly hidePreparedChild?: boolean;
  readonly draining?: boolean;
  readonly rejectCandidates?: boolean;
  readonly rejectCredential?: boolean;
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
  const store = createSessionStore(
    database,
    () => ids.shift() ?? "unexpected-parent-authority-id",
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
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
  const notify = vi.fn(() => {
    if (options.fenceOnNotify === true) {
      new RunnerStore(database).remove(TEST_USER_ID, RUNNER_ID, TEST_NOW + 3);
    }
  });
  const runtimes = new SessionRuntimes();
  if (options.hidePreparedChild === true) {
    const storedGet = store.get.bind(store);
    let childReads = 0;
    vi.spyOn(store, "get").mockImplementation((userId, sessionId) => {
      const detail = storedGet(userId, sessionId);
      if (
        detail?.parentSessionId === SESSION_ID &&
        detail.status === "queued"
      ) {
        childReads += 1;
        if (childReads === 2) return undefined;
      }
      return detail;
    });
  }
  const actions = createSessionAgentActions({
    ...inactiveSessionAgentActionDefaults(),
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
    ...(options.draining === true ? { draining: () => true } : {}),
    launchSession: launch,
    ...(options.rejectCandidates === true
      ? {
          modelCredentialPool: new RejectingModelCredentialPool({
            database,
            readCredential: () => Promise.resolve(undefined),
          }),
        }
      : {}),
    notify,
    now: () => TEST_NOW + 3,
    readCredential: () => Promise.resolve(credential),
    runtimes,
    store,
    withCredential: async (_userId, _selection, action) => {
      if (options.gateCredential === true) {
        await credentialGate.wait();
      }
      if (options.rejectCredential === true) throw new Error("credential boom");
      return action(credential);
    },
  }).actions(
    SESSION_ID,
    TEST_USER_ID,
    parent.generation,
    DEFAULT_TOOL_SETTINGS,
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

export function fenceParent(setup: AuthoritySetup): void {
  expect(
    new RunnerStore(setup.database).remove(
      TEST_USER_ID,
      RUNNER_ID,
      TEST_NOW + 3,
    ),
  ).toBe(true);
}

export function spawnInput() {
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

export function closeAuthoritySetup(setup: AuthoritySetup): void {
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

export function expectOnlyParentSession(setup: AuthoritySetup): void {
  expect(setup.store.list(TEST_USER_ID)).toHaveLength(1);
  closeAuthoritySetup(setup);
}

export async function expectStaleSpawn(
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

export function targetDetail(setup: AuthoritySetup) {
  const target = setup.store.get(TEST_USER_ID, TARGET_SESSION_ID);
  if (target === undefined) {
    throw new Error("Target session not found");
  }
  return target;
}

export async function expectSpawnWithoutLaunch(
  setup: AuthoritySetup,
  input = spawnInput(),
): Promise<string> {
  const result = await setup.actions.spawnSession(
    input,
    new AbortController().signal,
  );
  expect(setup.launch).not.toHaveBeenCalled();
  return result;
}

export function closeSetup(setup: AuthoritySetup): void {
  setup.database.$client.close();
}

export function setupWithTarget(
  state: "credential" | "idle" | "running",
): AuthoritySetup {
  return authoritySetup({
    ...(state === "credential" ? { gateCredential: true } : {}),
    ...(state === "running" ? { runningTarget: true } : {}),
    withTarget: true,
  });
}

export async function expectCompactionScheduled(
  setup: AuthoritySetup,
  sessionId = TARGET_SESSION_ID,
): Promise<void> {
  expect(
    await setup.actions.compactSession(sessionId, new AbortController().signal),
  ).toContain("compaction_scheduled");
}

export async function expectCompactionRejected(
  setup: AuthoritySetup,
  sessionId: string,
): Promise<void> {
  await expectCompactionScheduled(setup, sessionId).catch((error: unknown) => {
    expect(error).toHaveProperty("message", "Session not found");
  });
}

export function expectTargetUnchanged(
  setup: AuthoritySetup,
  before: ReturnType<SessionStore["get"]>,
): void {
  expect(setup.store.get(TEST_USER_ID, TARGET_SESSION_ID)).toEqual(before);
}

export async function expectTargetUnchangedAfterFencing(
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

export function expectSessionActionThrows(
  action: () => unknown,
  message: string,
): void {
  expect(action).toThrow(message);
}

export function activeRuntime(setup: AuthoritySetup) {
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

export async function expectPendingCompaction(
  setup: AuthoritySetup,
  target: { readonly generation: number; readonly id: string },
): Promise<void> {
  await expectCompactionScheduled(setup, target.id);
  expect(
    setup.store.manualCompactionPending(target.id, target.generation),
  ).toBe(true);
}

export async function expectDeadlineRejection(
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

export function targetOperation(
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

export function credentialCaseSetup(): {
  readonly before: ReturnType<SessionStore["get"]>;
  readonly setup: AuthoritySetup;
} {
  const setup = setupWithTarget("credential");
  return { before: setup.store.get(TEST_USER_ID, TARGET_SESSION_ID), setup };
}

export interface ImmediateMutationCase {
  readonly execute: (
    setup: AuthoritySetup,
    signal: AbortSignal,
  ) => Promise<string> | string;
  readonly name: "reassign" | "steer" | "stop";
}

export function immediateMutationCases(): readonly ImmediateMutationCase[] {
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

export function immediateMutationSetup(
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
