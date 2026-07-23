import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  AGENT_TOOLS,
  SESSION_AGENT_TOOL_NAMES,
  selectedAgentTools,
} from "../../shared/agent-tools.ts";

function expectParallelRecipients(
  tools: ReturnType<typeof selectedAgentTools>,
  recipients: readonly string[],
): void {
  expect(
    tools.find(({ function: definition }) => definition.name === "parallel"),
  ).toMatchObject({
    function: {
      parameters: {
        properties: {
          tool_uses: {
            items: {
              properties: {
                recipient_name: { enum: recipients },
              },
            },
          },
        },
      },
    },
  });
}

test("lets parallel call every tool and skill except itself by default", () => {
  expectParallelRecipients(AGENT_TOOLS, [
    "read",
    "bash",
    "edit",
    "write",
    "brave_search",
    ...SESSION_AGENT_TOOL_NAMES,
  ]);
});

test("defines the session tools as one selectable group", () => {
  expect(SESSION_AGENT_TOOL_NAMES).toEqual([
    "spawn_session",
    "list_sessions",
    "read_session",
    "send_to_session",
    "continue_session",
    "stop_session",
  ]);
  expect(
    AGENT_TOOLS.filter(({ function: definition }) =>
      SESSION_AGENT_TOOL_NAMES.includes(definition.name),
    ).map(({ function: definition }) => definition.name),
  ).toEqual(SESSION_AGENT_TOOL_NAMES);
  expect(
    AGENT_SESSION_TOOL_OPTIONS.filter(({ name }) =>
      SESSION_AGENT_TOOL_NAMES.includes(name),
    ).every(({ kind }) => kind === "tool"),
  ).toBe(true);
});

test("limits parallel calls to enabled tools and skills", () => {
  const tools = selectedAgentTools(["read", "parallel", "brave_search"]);

  expect(tools.map(({ function: definition }) => definition.name)).toEqual([
    "read",
    "parallel",
    "brave_search",
  ]);
  expectParallelRecipients(tools, ["read", "brave_search"]);
});
