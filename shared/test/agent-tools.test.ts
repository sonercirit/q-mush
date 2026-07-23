import { expect, test } from "vitest";
import { AGENT_TOOLS, selectedAgentTools } from "../../shared/agent-tools.ts";

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
  ]);
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
