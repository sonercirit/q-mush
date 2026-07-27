import { expect } from "vitest";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../../shared/session-model.ts";
import { recoverSessionRestartHandoffs } from "../../sync-engine/session-restart-recovery.ts";
import type { RestartHandoffIdentity } from "../../sync-engine/session-restart-store.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import {
  claimRestartStore,
  pauseRestartStore,
  requireCompactionSession,
  runningRestartStore,
  startClaimedRestart,
} from "./session-compaction-test-helpers.ts";

type RestartRecoveryDependencies = Parameters<
  typeof recoverSessionRestartHandoffs
>[0];

type RestartRecoveryLaunch = RestartRecoveryDependencies["launch"];
const RESTART_TEST_CREDENTIAL: ProviderCredentialAccess = {
  accountId: "restart-test-account",
  id: "018bcfe5-6800-7000-8000-000000000042",
  isDefault: false,
  label: "Restart test key",
  secret: "restart-test-secret",
  source: "api_key",
};

export function restartTestCredential(
  id: string,
  overrides: Partial<ProviderCredentialAccess> = {},
): ProviderCredentialAccess {
  return { ...RESTART_TEST_CREDENTIAL, id, ...overrides };
}

interface RestartRecoveryOptions {
  readonly credential?: RestartRecoveryDependencies["credential"];
  readonly launch: RestartRecoveryLaunch;
  readonly notify?: RestartRecoveryDependencies["notify"];
  readonly now: RestartRecoveryDependencies["now"];
  readonly restartId?: string;
  readonly runnerIsAvailable?: RestartRecoveryDependencies["runnerIsAvailable"];
  readonly store: RestartRecoveryDependencies["store"];
}

export function recoverRestartTestHandoffs(
  options: RestartRecoveryOptions,
): ReturnType<typeof recoverSessionRestartHandoffs> {
  return recoverSessionRestartHandoffs({
    credential:
      options.credential ?? (() => Promise.resolve(RESTART_TEST_CREDENTIAL)),
    launch: options.launch,
    notify: options.notify ?? (() => undefined),
    now: options.now,
    ...(options.restartId === undefined
      ? {}
      : { restartId: options.restartId }),
    runnerIsAvailable: options.runnerIsAvailable ?? (() => true),
    store: options.store,
  });
}

interface RestartSettlementOptions {
  readonly gate?: Promise<unknown>;
  readonly turns?: number;
}

export async function settleRestartRecovery(
  options: RestartSettlementOptions = {},
): Promise<void> {
  if (options.gate !== undefined) {
    await options.gate;
  }
  const turns = options.turns ?? 2;
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

export function expectRestartState(
  detail: AgentSessionDetail | undefined,
  identity: Pick<RestartHandoffIdentity, "generation" | "restartId">,
  status: AgentSessionDetail["status"],
): void {
  expect(detail).toMatchObject({
    generation: identity.generation,
    restartHandoff: { restartId: identity.restartId },
    status,
  });
}

export function pausedRunnerRestartStore(
  restartId: string,
  operation: RestartHandoffOperation = "agent",
) {
  const setup = runningRestartStore();
  const running = requireCompactionSession(setup.store);
  expect(
    setup.store.pauseRunningForRestart(
      { generation: running.generation, sessionId: running.id },
      "runner",
      restartId,
      operation,
      TEST_NOW + 2,
    ),
  ).toBe(true);
  return {
    identity: {
      generation: running.generation + 1,
      restartId,
      sessionId: running.id,
    },
    setup,
  };
}

type PreparedRestartStatus = "paused" | "queued" | "running";

export function restartStoreAtStatus(
  status: PreparedRestartStatus,
  restartId: string,
  operation: RestartHandoffOperation = "compact",
) {
  const setup = runningRestartStore();
  const identity = pauseRestartStore(setup, restartId, operation);
  if (status !== "paused") {
    claimRestartStore(setup, identity);
  }
  if (status === "running") {
    startClaimedRestart(setup, identity);
  }
  return { identity, setup };
}
