import type { AgentFile } from "./agent-file.ts";
import type { RunnerExecutionEnvironment } from "./runner-command-broker.ts";

export const AGENT_SYSTEM_PROMPT = `You are Q Mush, a careful coding agent operating in a user-selected workspace.
Inspect existing files before changing them. Make the smallest coherent change that satisfies the request. Use tools rather than guessing about repository contents. Preserve existing conventions, avoid secrets, and run focused checks after edits. Explain the result concisely when the work is complete. Never claim that a tool succeeded unless its result says so.`;

export function createAgentSystemPrompt(
  agentFile: AgentFile | null,
  executionEnvironment: RunnerExecutionEnvironment = "bare_metal",
): string {
  const environment =
    executionEnvironment === "container"
      ? "Shell tools execute inside an isolated container whose state persists for this session only and whose network access is disabled. The canonical workspace is mounted there at /workspace; use /workspace for absolute paths. File tools remain confined to the canonical workspace by host-side enforcement, so their changes are immediately visible in the container."
      : "File and shell tools execute directly on the selected runner.";
  const base = `${AGENT_SYSTEM_PROMPT}\n${environment}`;
  if (agentFile === null) {
    return base;
  }

  return `${base}

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="${agentFile.name}">
${agentFile.content}
</project_instructions>

</project_context>`;
}
