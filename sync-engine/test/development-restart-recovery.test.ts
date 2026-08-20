import { expect, test } from "vitest";
import { restoreRejectedDevelopmentDrainRecovery } from "../../sync-engine/development-restart-recovery.ts";

test("restores shutdown-marker recovery after a rejected development drain", async () => {
  let recoveryEnabled = false;

  await Promise.reject(new Error("drain failed")).catch(() => {
    restoreRejectedDevelopmentDrainRecovery({
      restoreDevelopmentDrainRecovery: () => {
        recoveryEnabled = true;
      },
    });
  });

  expect(recoveryEnabled).toBe(true);
});
