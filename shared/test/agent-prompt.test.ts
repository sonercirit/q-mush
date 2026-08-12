import { expect, test } from "vitest";
import {
  AGENT_SYSTEM_PROMPT,
  createAgentSystemPrompt,
} from "../../shared/agent-prompt.ts";

test("describes the root Arch container environment for container sessions", () => {
  const prompt = createAgentSystemPrompt(null, "container");

  expect(prompt).toContain("root");
  expect(prompt).toContain("Arch Linux");
  expect(prompt).toContain("pacman");
  expect(prompt).toContain("/workspace");
  expect(prompt).toContain("permission error");
  expect(prompt).toContain("chown");
  expect(prompt).toContain("stat -c %u:%g /workspace");
  expect(prompt).toContain("use the network");
  expect(prompt).toContain("unless the runner overrides the image");
  expect(prompt).not.toContain("network access is disabled");
});

test("adds a selected workspace agent file to the system prompt", () => {
  expect(createAgentSystemPrompt(null)).toBe(
    `${AGENT_SYSTEM_PROMPT}\nFile and shell tools execute directly on the selected runner.`,
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
