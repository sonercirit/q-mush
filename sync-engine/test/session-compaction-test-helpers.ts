import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import type { RunnerCommandResult } from "../../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  RestartHandoff,
  RestartHandoffOperation,
} from "../../shared/session-model.ts";
import {
  RestartHandoffStore,
  type RestartHandoffIdentity,
} from "../../sync-engine/session-restart-store.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

export interface CompactionStoreSetup {
  readonly database: AppDatabase;
  readonly store: SessionStore;
}
export type RestartStoreSetup = CompactionStoreSetup & {
  readonly restart: RestartHandoffStore;
};

export function runningCompactionStore(): CompactionStoreSetup {
  const setup = createStore();
  const queued = createTestSession(setup.store);
  expect(
    setup.store.transitionRuntime(
      queued.id,
      "running",
      TEST_NOW + 1,
      queued.generation,
    ),
  ).toBe(true);
  return setup;
}

export function appendCompactionAssistantMessage(
  setup: CompactionStoreSetup,
  content: string,
): void {
  setup.store.appendCurrentAgentMessage(
    STORE_SESSION_ID,
    { content, role: "assistant", toolCalls: [] },
    TEST_NOW + 2,
  );
}

export function requireCompactionSession(
  store: SessionStore,
): AgentSessionDetail {
  const session = store.get(TEST_USER_ID, STORE_SESSION_ID);
  if (session === undefined) {
    throw new Error("The compaction test session is unavailable");
  }
  return session;
}

export function completeNullRunnerCommand(
  broker: Readonly<
    | {
        complete: (
          runnerId: string,
          commandId: string,
          result: RunnerCommandResult,
        ) => boolean;
      }
    | {
        completeRunnerCommand: (
          runnerId: string,
          commandId: string,
          result: RunnerCommandResult,
        ) => boolean;
      }
  >,
  runnerId: string,
  commandId: string,
): void {
  const result = { output: "null", state: "completed" } as const;
  expect(
    "complete" in broker
      ? broker.complete(runnerId, commandId, result)
      : broker.completeRunnerCommand(runnerId, commandId, result),
  ).toBe(true);
}

export function expectCompactedIdleSession(
  store: SessionStore,
  expectedContent: string,
  expectedUsage: Readonly<{
    contextTokens?: number;
    costUsd?: number;
  }> = {},
): AgentSessionDetail {
  const settled = requireCompactionSession(store);
  expect(settled).toMatchObject({
    ...(expectedUsage.contextTokens === undefined
      ? {}
      : { currentContextTokens: expectedUsage.contextTokens }),
    ...(expectedUsage.costUsd === undefined
      ? {}
      : { costUsd: expectedUsage.costUsd }),
    messages: [{ role: "user" }],
    restartHandoff: null,
    status: "idle",
  });
  expect(settled.messages[0]?.content).toContain(expectedContent);
  return settled;
}

export function runningRestartStore(): RestartStoreSetup {
  const setup = runningCompactionStore();
  return {
    ...setup,
    restart: new RestartHandoffStore({
      database: setup.database,
      generateId: () => "restart-error-message",
      read: (userId, sessionId) => setup.store.get(userId, sessionId),
    }),
  };
}

function restartIdentity(
  generation: number,
  restartId: string,
  sessionId = STORE_SESSION_ID,
): RestartHandoffIdentity {
  return { generation, restartId, sessionId };
}

export function pauseRestartStore(
  setup: RestartStoreSetup,
  restartId = "restart-1",
  operation: RestartHandoffOperation = "compact",
): RestartHandoffIdentity {
  const running = requireCompactionSession(setup.store);
  expect(
    setup.restart.pauseRunning(
      { generation: running.generation, sessionId: running.id },
      "server",
      restartId,
      operation,
      TEST_NOW + 2,
    ),
  ).toBe(true);
  return restartIdentity(running.generation + 1, restartId, running.id);
}

export function claimRestartStore(
  setup: RestartStoreSetup,
  identity: RestartHandoffIdentity,
): AgentSessionDetail {
  const claimed = setup.restart.claim(TEST_USER_ID, identity, TEST_NOW + 3);
  expect(claimed).toBeDefined();
  if (claimed === undefined) {
    throw new Error("The restart test handoff could not be claimed");
  }
  return claimed;
}

export function startClaimedRestart(
  setup: CompactionStoreSetup,
  identity: RestartHandoffIdentity,
): void {
  expect(
    setup.store.transitionRuntime(
      identity.sessionId,
      "running",
      TEST_NOW + 4,
      identity.generation,
    ),
  ).toBe(true);
}

export function readRawRestartHandoff(
  setup: CompactionStoreSetup,
): string | null | undefined {
  return setup.database
    .select({ restartHandoff: agentSessions.restartHandoff })
    .from(agentSessions)
    .where(eq(agentSessions.id, STORE_SESSION_ID))
    .get()?.restartHandoff;
}

function restartHandoff(
  executionGeneration: number,
  restartId: string,
  options: {
    readonly operation?: RestartHandoffOperation;
    readonly requestedBy?: RestartHandoff["requestedBy"];
  } = {},
): RestartHandoff {
  return {
    executionGeneration,
    operation: options.operation ?? "agent",
    pendingInput: [],
    requestedBy: options.requestedBy ?? "runner",
    restartId,
  };
}

export function forceNewerRestartHandoff(
  setup: CompactionStoreSetup,
  restartId: string,
  status: "paused" | "queued" = "paused",
): RestartHandoff {
  const current = requireCompactionSession(setup.store);
  const handoff = restartHandoff(current.generation + 1, restartId);
  setup.database
    .update(agentSessions)
    .set({
      executionGeneration: handoff.executionGeneration,
      restartHandoff: JSON.stringify(handoff),
      status,
    })
    .where(
      and(
        eq(agentSessions.id, STORE_SESSION_ID),
        eq(agentSessions.executionGeneration, current.generation),
      ),
    )
    .run();
  return handoff;
}

export function closeCompactionStore(setup: CompactionStoreSetup): void {
  setup.database.$client.close();
}

export function forceSessionStatus(
  setup: CompactionStoreSetup,
  status: "paused" | "running",
  activeStartedAt?: number,
): void {
  setup.database
    .update(agentSessions)
    .set({
      ...(activeStartedAt === undefined
        ? {}
        : { activeStartedAt: new Date(activeStartedAt) }),
      status,
    })
    .where(eq(agentSessions.id, STORE_SESSION_ID))
    .run();
}
