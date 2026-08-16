import { expect, test } from "vitest";
import {
  AGENT_SYSTEM_PROMPT,
  createAgentSystemPrompt,
} from "../../shared/agent-prompt.ts";
import { SHARED_TOOL_LIMITS_STATEMENT } from "../../shared/tool-limits.ts";

test("states the global tool limits once for every environment", () => {
  // The shared statement is authoritative; per-tool descriptions must not
  // repeat the limits.
  expect(SHARED_TOOL_LIMITS_STATEMENT).toContain("30 minutes");
  expect(SHARED_TOOL_LIMITS_STATEMENT).toContain("2,000");
  expect(SHARED_TOOL_LIMITS_STATEMENT).toContain("50 KB");
  // ask_questions pauses the session instead of running work, so the time
  // limit does not cover the wait for an answer; the statement must say so.
  expect(SHARED_TOOL_LIMITS_STATEMENT).toContain("ask_questions");
  // A parallel call is one budgeted call: its batch shares the time limit.
  expect(SHARED_TOOL_LIMITS_STATEMENT).toContain("parallel batch shares");
  expect(createAgentSystemPrompt(null)).toContain(SHARED_TOOL_LIMITS_STATEMENT);
  expect(createAgentSystemPrompt(null, "container")).toContain(
    SHARED_TOOL_LIMITS_STATEMENT,
  );
});

test("describes the root Arch container environment for container sessions", () => {
  const prompt = createAgentSystemPrompt(null, "container");

  expect(prompt).toContain("root");
  expect(prompt).toContain("Arch Linux");
  expect(prompt).toContain("pacman");
  // The image ships without synced databases; a bare pacman -S fails and
  // partial upgrades (-Sy + install) are unsupported on Arch.
  expect(prompt).toContain("pacman -Syu");
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
    `${AGENT_SYSTEM_PROMPT}\nFile and shell tools execute directly on the selected runner.\n${SHARED_TOOL_LIMITS_STATEMENT}`,
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
