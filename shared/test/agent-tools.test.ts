import { expect, test } from "vitest";
import { selectedAgentTools } from "../../shared/agent-tools.ts";

test("limits parallel calls to the selected base tools", () => {
  const tools = selectedAgentTools(["read", "write", "parallel"]);

  expect(tools.map(({ function: definition }) => definition.name)).toEqual([
    "read",
    "write",
    "parallel",
  ]);
  expect(
    tools.find(({ function: definition }) => definition.name === "parallel"),
  ).toMatchObject({
    function: {
      parameters: {
        properties: {
          tool_uses: {
            items: {
              properties: {
                recipient_name: { enum: ["read", "write"] },
              },
            },
          },
        },
      },
    },
  });
});
