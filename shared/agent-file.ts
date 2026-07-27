import { isRecord } from "./auth-model.ts";

export const AGENT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const RUNNER_AGENT_FILE_COMMAND = "read_agent_file";

export type AgentFileName = (typeof AGENT_FILE_NAMES)[number];

export interface AgentFile {
  readonly content: string;
  readonly name: AgentFileName;
}

function isAgentFileName(value: unknown): value is AgentFileName {
  return AGENT_FILE_NAMES.some((name) => name === value);
}

export function readAgentFile(value: unknown): AgentFile | null {
  if (value !== null) {
    if (
      !isRecord(value) ||
      !isAgentFileName(value["name"]) ||
      typeof value["content"] !== "string"
    ) {
      throw new Error("The runner returned an invalid agent file");
    }

    return { content: value["content"], name: value["name"] };
  }

  return null;
}

export function readRunnerAgentFileOutput(output: string): AgentFile | null {
  if (output.startsWith("Error: ")) {
    throw new Error(output.slice("Error: ".length));
  }

  let value: unknown;

  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("The runner returned an invalid agent file");
  }

  return readAgentFile(value);
}
