import { expect, test } from "vitest";
import { recoverSessionRestartHandoffs } from "../../sync-engine/session-restart-recovery.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import {
  closeCompactionStore,
  requireCompactionSession,
} from "./session-compaction-test-helpers.ts";
import { restartStoreAtStatus } from "./session-restart-cpd-helpers.ts";
import { CREDENTIAL } from "./session-restart-orchestration-test-helpers.ts";

function recoveryDefaults(
  store: Parameters<typeof recoverSessionRestartHandoffs>[0]["store"],
) {
  return {
    notify: () => undefined,
    now: () => TEST_NOW,
    runnerIsAvailable: () => true,
    store,
  };
}

async function recoverRetry(
  failed: ReturnType<typeof restartStoreAtStatus>,
  result: false | "x",
): Promise<void> {
  await recoverSessionRestartHandoffs({
    credential: () => Promise.resolve(CREDENTIAL),
    launch: () => {
      if (result === "x") throw new Error();
      return false;
    },
    ...recoveryDefaults(failed.setup.store),
  });
}

test("recovery retries a refused launch and fails a thrown launch visibly", async () => {
  const refused = restartStoreAtStatus("paused", "l");
  await recoverRetry(refused, false);
  expect(requireCompactionSession(refused.setup.store).status).toBe("paused");
  closeCompactionStore(refused.setup);

  const failed = restartStoreAtStatus("paused", "x");
  await recoverRetry(failed, "x");
  expect(requireCompactionSession(failed.setup.store)).toMatchObject({
    restartHandoff: null,
    status: "failed",
  });
  closeCompactionStore(failed.setup);

  const replayed = restartStoreAtStatus("paused", "r");
  const launches: string[] = [];
  const credentialGate = Promise.withResolvers<undefined>();
  const recoveryDependencies = {
    credential: () => credentialGate.promise.then(() => CREDENTIAL),
    launch: (detail: { readonly id: string }) => (
      launches.push(detail.id),
      true
    ),
    ...recoveryDefaults(replayed.setup.store),
  };
  const recover = () => recoverSessionRestartHandoffs(recoveryDependencies);
  const recoveries = [recover(), recover()];
  credentialGate.resolve();
  await Promise.all(recoveries);
  expect(launches).toEqual([replayed.identity.sessionId]);
  await recover();
  expect(launches).toEqual([replayed.identity.sessionId]);
  expect(requireCompactionSession(replayed.setup.store).status).toBe("queued");
  closeCompactionStore(replayed.setup);
});
