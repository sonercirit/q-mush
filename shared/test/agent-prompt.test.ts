import { expect, test } from "vitest";
import {
  AGENT_SYSTEM_PROMPT,
  createAgentSystemPrompt,
} from "../../shared/agent-prompt.ts";

test("adds a selected workspace agent file to the system prompt", () => {
  expect(createAgentSystemPrompt(null)).toBe(AGENT_SYSTEM_PROMPT);

  const prompt = createAgentSystemPrompt({
    content: "Run the focused tests before finishing.",
    name: "AGENTS.md",
  });

  expect(prompt.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true);
  expect(prompt).toContain('<project_instructions path="AGENTS.md">');
  expect(prompt).toContain("Run the focused tests before finishing.");
  expect(prompt).not.toContain("CLAUDE.md");
});
