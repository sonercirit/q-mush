import { expect, test } from "vitest";
import { createAgentSkills } from "../agent-skills.ts";

function braveSearch() {
  return { execute: () => Promise.resolve("unused search") };
}

test("rejects sleep inside parallel without dispatching it", async () => {
  const calls: string[] = [];
  const skills = createAgentSkills({
    braveSearch: braveSearch(),
    executeTool: (name) => {
      calls.push(name);
      return Promise.resolve("ok");
    },
    tools: ["read", "parallel", "sleep"],
    userId: "user-id",
  });
  const toolUses = [
    { parameters: { durationMs: 10 }, recipient_name: "sleep" },
    { parameters: {}, recipient_name: "read" },
  ];
  const output = await skills.execute("parallel", { tool_uses: toolUses });

  expect(calls).toEqual(["read"]);
  expect(output).toContain("Error: sleep cannot run inside parallel.");
});
