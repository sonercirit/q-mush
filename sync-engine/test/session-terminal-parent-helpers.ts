import type { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";

export async function waitForTerminalParentNote(
  sessions: ReturnType<typeof createSessionIntegration>,
  childId: string,
): Promise<void> {
  const parentId = sessions.detailForUser(
    TEST_USER_ID,
    childId,
  )?.parentSessionId;
  if (parentId === null || parentId === undefined) {
    throw new Error("The child parent is unavailable");
  }
  await waitForSessionValue(
    () => sessions.detailForUser(TEST_USER_ID, parentId),
    (value) => {
      const serialized = JSON.stringify(value);
      return (
        serialized.includes("Spawned session") && serialized.includes(childId)
      );
    },
  );
}
