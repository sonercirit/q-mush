import { RUNNER_AGENT_FILE_COMMAND } from "../shared/agent-file.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  failedRunnerCommandResult,
  type RunnerCommandResult,
  type RunnerToolCommand,
  type RunnerToolOutputDelta,
} from "../shared/runner-command-broker.ts";
import { RUNNER_DIRECTORY_COMMAND } from "../shared/runner-directory-model.ts";
import { loadRunnerAgentFile } from "./runner-agent-file.ts";
import { listRunnerDirectories } from "./runner-directories.ts";
import { executeRunnerToolResult } from "./runner-tools.ts";

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

export async function executeRunnerCommandResult(
  command: RunnerToolCommand,
  signal?: AbortSignal,
  stream?: (delta: Omit<RunnerToolOutputDelta, "sequence">) => void,
): Promise<RunnerCommandResult> {
  try {
    if (command.tool === RUNNER_DIRECTORY_COMMAND) {
      return {
        output: JSON.stringify(
          await listRunnerDirectories(command.workingDirectory),
        ),
        state: "completed",
      };
    }

    if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
      return {
        output: JSON.stringify(
          await loadRunnerAgentFile(command.workingDirectory),
        ),
        state: "completed",
      };
    }

    return await executeRunnerToolResult(
      command.workingDirectory,
      command.tool,
      command.arguments,
      signal,
      stream,
    );
  } catch (error) {
    return failedRunnerCommandResult(error, 1_000);
  }
}
