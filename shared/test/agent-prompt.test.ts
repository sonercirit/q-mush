import { expect, test } from "vitest";
import {
  AGENT_SYSTEM_PROMPT,
  createAgentSystemPrompt,
} from "../../shared/agent-prompt.ts";

test("adds a selected workspace agent file to the system prompt", () => {
  const bareMetalPrompt = createAgentSystemPrompt(null);
  expect(bareMetalPrompt.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true);
  expect(bareMetalPrompt).toContain("directly on the selected runner");
  expect(createAgentSystemPrompt(null, "container")).toContain(
    "Shell tools execute inside an isolated container",
  );
  expect(createAgentSystemPrompt(null, "container")).toContain(
    "File tools remain confined to the canonical workspace",
  );

  const prompt = createAgentSystemPrompt({
    content: "Run the focused tests before finishing.",
    name: "AGENTS.md",
  });

  expect(prompt.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true);
  expect(prompt).toContain('<project_instructions path="AGENTS.md">');
  expect(prompt).toContain("Run the focused tests before finishing.");
  expect(prompt).not.toContain("CLAUDE.md");
});
