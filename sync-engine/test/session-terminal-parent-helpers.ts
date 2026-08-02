import type { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";

export async function waitForTerminalParentNote(
  sessions: ReturnType<typeof createSessionIntegration>,
  childId: string,
): Promise<void> {
  await waitForSessionValue(
    () => sessions.detailForUser(TEST_USER_ID, childId),
    (value) => JSON.stringify(value).includes("already terminal"),
  );
}
