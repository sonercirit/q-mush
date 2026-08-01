import { describe, expect, test } from "vitest";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import {
  childSessionId,
  completeChildAgentFile,
  spawnCall,
} from "./session-agent-spawn-helpers.ts";
import {
  scriptedModel,
  startToolSession,
  toolCall,
  waitForSessionContent,
} from "./session-agent-tool-setup.ts";
import { SESSION_ID } from "./session-integration-fixtures.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

async function failedChildReport(content: string): Promise<{
  readonly report: string;
  readonly setup: Awaited<ReturnType<typeof startToolSession>>;
}> {
  const model = scriptedModel([
    {
      content: "Delegating work that may fail.",
      toolCalls: [
        spawnCall("Make progress, then fail", undefined, ["list_runners"]),
      ],
    },
    { content: "I am waiting for the report.", toolCalls: [] },
    { content, toolCalls: [toolCall("list_runners", {})] },
  ]);
  const setup = await startToolSession(model, { agentFile: null });
  const childId = await childSessionId(setup);
  const child = setup.sessions.detailForUser(TEST_USER_ID, childId);
  expect(child?.parentSessionId).toBe(SESSION_ID);
  completeChildAgentFile(setup);
  const parent = await waitForSessionContent(setup, "Spawned session failed");
  return { report: JSON.stringify(parent), setup };
}

function expectFailedReport(report: string, expectedContent: string): void {
  expect(report).toContain(expectedContent);
  expect(report).toContain('\\"status\\": \\"failed\\"');
}

describe("failed spawned session reports", () => {
  test("includes the child's last assistant message", async () => {
    const { report, setup } = await failedChildReport(
      "The child made partial progress.",
    );

    expectFailedReport(report, "The child made partial progress.");
    closeSessionTestDatabase(setup.database);
  });

  test("includes an explicit reason when the child has no assistant content", async () => {
    const { report, setup } = await failedChildReport("");

    expectFailedReport(report, "The scripted model ran out of turns");
    closeSessionTestDatabase(setup.database);
  });
});
