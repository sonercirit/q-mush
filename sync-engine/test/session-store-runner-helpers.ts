import { createHash } from "node:crypto";
import type { AppDatabase } from "../../shared/database.ts";
import { runners } from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";

export function addSessionTestRunner(
  database: AppDatabase,
  machineFingerprint: string,
  runnerId: string,
): void {
  database
    .insert(runners)
    .values({
      ...testAuditFields(),
      architecture: "x64",
      id: runnerId,
      lastSeenAt: new Date(TEST_NOW),
      machineFingerprint,
      name: "workstation",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update(`runner-token-${machineFingerprint}`)
        .digest("base64url"),
      userId: TEST_USER_ID,
    })
    .run();
}
