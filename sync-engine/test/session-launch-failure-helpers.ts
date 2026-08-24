import { expect, vi } from "vitest";
import {
  createRunnerCommandBroker,
  type RunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import {
  installDatabaseWriteResilience,
  type DatabaseWriteResilience,
} from "../../sync-engine/database-write-resilience.ts";
import type { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import { SessionFinisher } from "../../sync-engine/session-finisher.ts";
import type { SessionLauncher } from "../../sync-engine/session-launcher.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import type { CompactionStoreSetup } from "./session-compaction-test-helpers.ts";
import { createSessionLauncher } from "./session-launcher-fixtures.ts";
import {
  CREDENTIAL,
  orchestrationActions,
} from "./session-restart-orchestration-test-helpers.ts";
import { createTestSession } from "./session-store-test-fixtures.ts";

export interface LaunchFailureSetup {
  readonly actions: SessionAgentActions;
  readonly broker: RunnerCommandBroker;
  readonly detail: AgentSessionDetail;
  readonly finished: ReturnType<typeof vi.fn>;
  readonly hasPendingReconciliation: () => boolean;
  readonly launcher: SessionLauncher;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly reconcile: () => boolean;
  readonly runtimes: SessionRuntimes;
  readonly storeSetup: CompactionStoreSetup;
}

export function launchFailureSetup(
  storeSetup: CompactionStoreSetup,
  resilience: DatabaseWriteResilience,
  now: number,
  existingDetail?: AgentSessionDetail,
): LaunchFailureSetup {
  const detail = existingDetail ?? createTestSession(storeSetup.store);
  const notify = vi.fn();
  const actions = orchestrationActions(storeSetup.database, storeSetup.store);
  const finished = vi.spyOn(actions, "finished");
  const runtimes = new SessionRuntimes();
  const broker = createRunnerCommandBroker({
    commandId: () => "recovered-launch-agent-file",
  });
  const pending = new Map<string, Parameters<SessionFinisher["finish"]>>();
  const finisher = new SessionFinisher({
    actions,
    notify,
    now: () => now + 2,
    reconciliationFailed: ({
      detail: failedDetail,
      error,
      recovered,
      userId,
    }) => {
      pending.set(
        failedDetail.id,
        recovered === undefined
          ? [failedDetail, userId, error]
          : [failedDetail, userId, error, recovered],
      );
    },
    store: storeSetup.store,
  });
  const launcher = createSessionLauncher({
    actions,
    broker,
    finish: finisher.finish.bind(finisher),
    modelFactory: () => ({
      complete: () =>
        Promise.resolve(providerStep("Continued after recovery.")),
    }),
    notify,
    now: () => now + 1,
    runtimes,
    store: storeSetup.store,
  });
  installDatabaseWriteResilience(storeSetup.database, resilience);
  expect(launcher.launch(detail, CREDENTIAL, TEST_USER_ID)).toBe(true);
  return {
    actions,
    broker,
    detail,
    finished,
    hasPendingReconciliation: () => pending.size > 0,
    launcher,
    notify,
    reconcile: () => {
      for (const [sessionId, parameters] of pending) {
        finisher.finish(...parameters);
        pending.delete(sessionId);
      }
      return pending.size === 0;
    },
    runtimes,
    storeSetup,
  };
}

export function expectFailedLaunch(setup: LaunchFailureSetup): void {
  expect(
    setup.storeSetup.store.get(TEST_USER_ID, setup.detail.id),
  ).toMatchObject({
    activeStartedAt: null,
    messages: [
      { role: "user" },
      {
        content:
          "Session failed: The database write failed because the disk is full",
        role: "error",
      },
    ],
    status: "failed",
  });
  expect(setup.notify).toHaveBeenCalledWith(TEST_USER_ID, setup.detail.id);
  expect(setup.finished).toHaveBeenCalledWith(setup.detail, TEST_USER_ID);
}
