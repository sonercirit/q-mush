import { expect, test } from "vitest";
import {
  AGENT_SYSTEM_PROMPT,
  createAgentSystemPrompt,
} from "../../shared/agent-prompt.ts";
import { CONFIGURED_TOOL_SETTINGS } from "../../shared/test/tool-settings-fixtures.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  formatToolLimitsStatement,
} from "../../shared/tool-limits.ts";

const DEFAULT_LIMITS_STATEMENT = formatToolLimitsStatement(
  DEFAULT_TOOL_SETTINGS,
);

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

test("states the global tool limits once for every environment", () => {
  // The shared statement is authoritative; per-tool descriptions must not
  // repeat the limits.
  expect(DEFAULT_LIMITS_STATEMENT).toContain("30 minutes");
  expect(DEFAULT_LIMITS_STATEMENT).toContain("20,000");
  expect(DEFAULT_LIMITS_STATEMENT).toContain("Unicode characters");
  expect(DEFAULT_LIMITS_STATEMENT).not.toContain("KB");
  // ask_questions pauses the session instead of running work, so the time
  // limit does not cover the wait for an answer; the statement must say so.
  expect(DEFAULT_LIMITS_STATEMENT).toContain("ask_questions");
  // A parallel call is one budgeted call: its batch shares the time limit.
  expect(DEFAULT_LIMITS_STATEMENT).toContain("parallel batch shares");
  expect(createAgentSystemPrompt(null)).toContain(DEFAULT_LIMITS_STATEMENT);
  expect(createAgentSystemPrompt(null, "container")).toContain(
    DEFAULT_LIMITS_STATEMENT,
  );
});

test("renders one configured per-run snapshot", () => {
  const settings = CONFIGURED_TOOL_SETTINGS;
  const statement = formatToolLimitsStatement(settings);
  const prompt = createAgentSystemPrompt(null, "bare_metal", settings);

  expect(occurrences(prompt, statement)).toBe(1);
  expect(prompt).toContain("7 minutes");
  expect(prompt).toContain("12,345 Unicode characters");
  expect(prompt).not.toContain("20,000 Unicode characters");
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
    `${AGENT_SYSTEM_PROMPT}\nFile and shell tools execute directly on the selected runner.\n${DEFAULT_LIMITS_STATEMENT}`,
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
