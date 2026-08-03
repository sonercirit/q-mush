import { expect, test } from "vitest";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import {
  scriptedModel,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import { RUNNER_ID, SESSION_ID } from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

const INTERRUPTED_TOOL_ERROR =
  "tool call was interrupted before it returned a result";

test.each(["runnerDisconnected", "runnerConnected"] as const)(
  "%s settles a command owned by the severed runner connection",
  async (event) => {
    const model = scriptedModel([
      {
        content: "Reading before the connection is severed.",
        toolCalls: [toolCall("read", { path: "README.md" })],
      },
    ]);
    const setup = await startToolSession(model, {
      commandId: (() => {
        let sequence = 0;
        return () => `agent-command-${String(++sequence)}`;
      })(),
    });
    const severed = await waitForSessionValue(
      setup.latestRunnerCommand,
      (command) =>
        typeof command === "object" &&
        command !== null &&
        "tool" in command &&
        command.tool === "read",
    );
    expect(severed).toMatchObject({
      id: "agent-command-2",
      tool: "read",
    });

    setup.sessions[event](RUNNER_ID);

    const failed = await waitForSessionValue(
      () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
      hasSessionStatus("failed"),
    );
    expect(JSON.stringify(failed).toLowerCase()).toContain(
      INTERRUPTED_TOOL_ERROR,
    );
    setup.database.$client.close();
  },
);
