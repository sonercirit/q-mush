import { expect, test } from "vitest";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
import { findToolResultContent } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  RUNNER_COMMAND_ID,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

test("parallel accepts provider-namespaced runner recipients", async () => {
  const model = createScriptedAgentModel([
    {
      content: "Read both files in parallel.",
      toolCalls: [
        toolCall("parallel", {
          tool_uses: [
            {
              parameters: { limit: 1, offset: 1, path: "AGENTS.md" },
              recipient_name: "functions.read",
            },
            {
              parameters: { limit: 1, offset: 1, path: "README.md" },
              recipient_name: "functions.read",
            },
          ],
        }),
      ],
    },
    { content: "Both reads completed.", toolCalls: [] },
  ]);
  let commandNumber = 0;
  const setup = await startToolSession(model, {
    commandId: () => {
      commandNumber += 1;
      return commandNumber === 1
        ? RUNNER_COMMAND_ID
        : `parallel-command-${String(commandNumber)}`;
    },
  });
  await waitForSessionValue(
    () => setup.runnerCommands.length,
    (length) => length === 2,
  );

  const commands = setup.runnerCommands.splice(0);
  expect(commands.map(({ tool }) => tool)).toEqual(["read", "read"]);
  for (const command of commands) {
    expect(
      setup.sessions.completeRunnerCommand(RUNNER_ID, command.id, {
        output: `read ${String(command.arguments["path"])}`,
        state: "completed",
      }),
    ).toBe(true);
  }

  const detail = await completedParentDetail(setup, "idle");
  const output = findToolResultContent(detail, "parallel");
  expect(output).toContain('"recipient_name": "functions.read"');
  expect(output).toContain("read AGENTS.md");
  expect(output).toContain("read README.md");
  expect(output).not.toContain("is not enabled for this session");
  closeSessionTestDatabase(setup.database);
});
