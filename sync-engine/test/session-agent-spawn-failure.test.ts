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
} from "./session-agent-tool-setup.ts";
import { SESSION_ID } from "./session-integration-fixtures.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import { waitForTerminalParentNote } from "./session-terminal-parent-helpers.ts";

async function failedChildReport(content: string): Promise<{
  readonly child: string;
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
  await waitForTerminalParentNote(setup.sessions, childId);
  return {
    child: JSON.stringify(setup.sessions.detailForUser(TEST_USER_ID, childId)),
    report: JSON.stringify(
      setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    ),
    setup,
  };
}

function expectFailedChild(
  child: string,
  report: string,
  expectedContent: string,
): void {
  expect(child).toContain(expectedContent);
  expect(report).toContain(expectedContent);
  expect(report).toContain('\\"status\\": \\"failed\\"');
}

describe("failed spawned session reports", () => {
  test("includes the child's last assistant message", async () => {
    const { child, report, setup } = await failedChildReport(
      "The child made partial progress.",
    );

    expectFailedChild(child, report, "The child made partial progress.");
    expect(
      setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    ).toMatchObject({ generation: 0, status: "idle" });
    closeSessionTestDatabase(setup.database);
  });

  test("includes an explicit reason when the child has no assistant content", async () => {
    const { child, report, setup } = await failedChildReport("");

    expectFailedChild(child, report, "The scripted model ran out of steps");
    closeSessionTestDatabase(setup.database);
  });
});
