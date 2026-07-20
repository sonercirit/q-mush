import { RUNNER_AGENT_FILE_COMMAND } from "./agent-file.ts";
import { isRecord } from "./auth-model.ts";
import { loadRunnerAgentFile } from "./runner-agent-file.ts";
import type { RunnerToolCommand } from "./runner-command-broker.ts";
import { listRunnerDirectories } from "./runner-directories.ts";
import { RUNNER_DIRECTORY_COMMAND } from "./runner-directory-model.ts";
import { executeRunnerTool } from "./runner-tools.ts";

const MAXIMUM_IDENTIFIER_LENGTH = 200;
const MAXIMUM_PATH_LENGTH = 4_096;
const MAXIMUM_TOOL_NAME_LENGTH = 100;

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
): string | undefined {
  const value = record[key];
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : undefined;
}

export function readRunnerCommand(value: unknown): RunnerToolCommand {
  if (!isRecord(value) || !isRecord(value["command"])) {
    throw new Error("The server returned an invalid runner command");
  }

  const command = value["command"];
  const arguments_ = command["arguments"];
  const id = requiredString(command, "id", MAXIMUM_IDENTIFIER_LENGTH);
  const sessionId = requiredString(
    command,
    "sessionId",
    MAXIMUM_IDENTIFIER_LENGTH,
  );
  const tool = requiredString(command, "tool", MAXIMUM_TOOL_NAME_LENGTH);
  const workingDirectory = requiredString(
    command,
    "workingDirectory",
    MAXIMUM_PATH_LENGTH,
  );

  if (
    !isRecord(arguments_) ||
    id === undefined ||
    sessionId === undefined ||
    tool === undefined ||
    workingDirectory === undefined ||
    workingDirectory.includes("\0")
  ) {
    throw new Error("The server returned an invalid runner command");
  }

  return {
    arguments: arguments_,
    id,
    sessionId,
    tool,
    workingDirectory,
  };
}

export function readRunnerCommandStatus(value: unknown): boolean {
  const active = isRecord(value) ? value["active"] : undefined;

  if (typeof active !== "boolean") {
    throw new Error("The server returned an invalid runner command status");
  }

  return active;
}

export async function executeRunnerCommand(
  command: RunnerToolCommand,
  signal?: AbortSignal,
): Promise<string> {
  try {
    if (command.tool === RUNNER_DIRECTORY_COMMAND) {
      return JSON.stringify(
        await listRunnerDirectories(command.workingDirectory),
      );
    }

    if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
      return JSON.stringify(
        await loadRunnerAgentFile(command.workingDirectory),
      );
    }

    return await executeRunnerTool(
      command.workingDirectory,
      command.tool,
      command.arguments,
      signal,
    );
  } catch (error) {
    if (error instanceof Error) {
      return `Error: ${error.message.slice(0, 1_000)}`;
    }

    return `Error: ${String(error).slice(0, 1_000)}`;
  }
}
