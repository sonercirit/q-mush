import { isRecord } from "./auth-model.ts";
import { isValidBoundedString } from "./string-validation.ts";

export const AGENT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const MAXIMUM_AGENT_FILE_PATH_LENGTH = 4_096;
export const RUNNER_AGENT_FILE_COMMAND = "read_agent_file";
export const RUNNER_AGENT_FILE_PATH_ARGUMENT = "path";

export interface AgentFile {
  readonly content: string;
  readonly name: string;
}

function isValidAgentFileName(value: unknown): value is string {
  return isValidBoundedString(value, MAXIMUM_AGENT_FILE_PATH_LENGTH);
}

export function readAgentFilePath(value: unknown): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const path = value.trim();
  if (path.length === 0) {
    return null;
  }
  return path.length <= MAXIMUM_AGENT_FILE_PATH_LENGTH && !path.includes("\0")
    ? path
    : undefined;
}

export function readOptionalAgentFilePath(
  value: unknown,
): string | null | undefined {
  return value === undefined ? null : readAgentFilePath(value);
}

export function readAgentFile(value: unknown): AgentFile | null {
  if (value !== null) {
    if (
      !isRecord(value) ||
      !isValidAgentFileName(value["name"]) ||
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
