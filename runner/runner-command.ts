import { isAbsolute, relative, resolve } from "node:path";
import {
  readAgentFilePath,
  RUNNER_AGENT_FILE_COMMAND,
  RUNNER_AGENT_FILE_PATH_ARGUMENT,
} from "../shared/agent-file.ts";
import { isRunnerAgentToolName } from "../shared/agent-tools.ts";
import {
  failedRunnerCommandResult,
  readRunnerExecutionEnvironment,
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type RunnerCommandArguments,
  type RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import { RUNNER_DIRECTORY_COMMAND } from "../shared/runner-directory-model.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_OUTPUT_CHARACTERS,
  MINIMUM_TOOL_OUTPUT_CHARACTERS,
  toolExecutionLimitSeconds,
} from "../shared/tool-limits.ts";
import { retainToolResultOverflow } from "../shared/tool-output-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import { isRecord, readBoundedString } from "../shared/validation.ts";
import { loadRunnerAgentFile } from "./runner-agent-file.ts";
import { executeAttachmentCommand } from "./runner-attachments.ts";
import {
  createRunnerContainerManager,
  type RunnerContainerManager,
} from "./runner-container.ts";
import { listRunnerDirectories } from "./runner-directories.ts";
import { runnerCommandResultFromOutput } from "./runner-process.ts";
import {
  executeRunnerToolResult,
  type RunnerToolExecutionOptions,
} from "./runner-tools.ts";
import { resolveRunnerWorkspace } from "./runner-workspace.ts";

const MAXIMUM_IDENTIFIER_LENGTH = 200;
const MAXIMUM_PATH_LENGTH = 4_096;
const MAXIMUM_TOOL_NAME_LENGTH = 100;

function recordString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
): string | undefined {
  return readBoundedString(record[key], { maximumLength });
}

function commandInteger(
  command: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = command[key];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("The server returned an invalid runner command");
  }
  return value;
}

export function readRunnerCommand(value: unknown): RunnerToolCommand {
  if (!isRecord(value) || !isRecord(value["command"])) {
    throw new Error("The server returned an invalid runner command");
  }
  const command = value["command"];
  const arguments_ = command["arguments"];
  const executionEnvironment = readRunnerExecutionEnvironment(
    command["executionEnvironment"],
  );
  const id = recordString(command, "id", MAXIMUM_IDENTIFIER_LENGTH);
  const executionLimitSeconds = commandInteger(
    command,
    "executionLimitSeconds",
    1,
    MAXIMUM_TOOL_EXECUTION_MINUTES * 60,
    toolExecutionLimitSeconds(DEFAULT_TOOL_SETTINGS),
  );
  const sessionId = recordString(
    command,
    "sessionId",
    MAXIMUM_IDENTIFIER_LENGTH,
  );
  const tool = recordString(command, "tool", MAXIMUM_TOOL_NAME_LENGTH);
  const outputLimitCharacters = commandInteger(
    command,
    "outputLimitCharacters",
    MINIMUM_TOOL_OUTPUT_CHARACTERS,
    MAXIMUM_TOOL_OUTPUT_CHARACTERS,
    DEFAULT_TOOL_SETTINGS.outputLimitCharacters,
  );
  const workingDirectory = recordString(
    command,
    "workingDirectory",
    MAXIMUM_PATH_LENGTH,
  );
  if (
    !isRecord(arguments_) ||
    executionEnvironment === undefined ||
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
    executionEnvironment,
    executionLimitSeconds,
    id,
    outputLimitCharacters,
    sessionId,
    tool,
    workingDirectory,
  };
}

type RunnerContainerCommands = Pick<
  RunnerContainerManager,
  "cleanupSession" | "executeShell" | "prepare"
>;

function mapContainerPath(root: string, path: string): string {
  if (path === "/workspace") return root;
  return isAbsolute(path) && path.startsWith("/workspace/")
    ? resolve(root, relative("/workspace", path))
    : path;
}

function agentFileResult(
  workingDirectory: string,
  arguments_: RunnerCommandArguments,
  contained = false,
): Promise<RunnerCommandResult> {
  const pathValue = arguments_[RUNNER_AGENT_FILE_PATH_ARGUMENT];
  const path =
    pathValue === undefined ? undefined : readAgentFilePath(pathValue);
  if (path === null || (pathValue !== undefined && path === undefined)) {
    return Promise.reject(new Error("The agent file path is invalid"));
  }
  return loadRunnerAgentFile(workingDirectory, path, contained).then(
    (agentFile) => ({
      output: JSON.stringify(agentFile),
      state: "completed",
    }),
  );
}

/** @public Backwards-compatible runner command helper. */
export async function executeRunnerCommand(
  command: RunnerToolCommand,
  signal?: AbortSignal,
): Promise<string> {
  return createRunnerCommandExecutor().execute(command, signal);
}

type ResolvedRunnerToolCommand = RunnerToolCommand & {
  readonly executionLimitSeconds: number;
  readonly outputLimitCharacters: number;
};

type ExecuteRunnerCommandResult =
  RunnerCommandExecutorFunction<RunnerCommandResult>;

type RunnerCommandExecutorFunction<Result> = (
  command: RunnerToolCommand,
  signal?: AbortSignal,
  stream?: NonNullable<RunnerToolExecutionOptions["stream"]>,
) => Promise<Result>;

export interface RunnerCommandExecutor {
  readonly execute: (
    command: RunnerToolCommand,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly executeResult: ExecuteRunnerCommandResult;
}

export function createRunnerCommandExecutor(
  providedContainers?: RunnerContainerCommands,
): RunnerCommandExecutor {
  const containers = providedContainers ?? createRunnerContainerManager();

  const toolSettings = (
    command: RunnerToolCommand,
  ): Pick<
    ResolvedRunnerToolCommand,
    "executionLimitSeconds" | "outputLimitCharacters"
  > => {
    return {
      executionLimitSeconds:
        command.executionLimitSeconds ??
        toolExecutionLimitSeconds(DEFAULT_TOOL_SETTINGS),
      outputLimitCharacters:
        command.outputLimitCharacters ??
        DEFAULT_TOOL_SETTINGS.outputLimitCharacters,
    };
  };

  const executeResult: ExecuteRunnerCommandResult = async (
    command,
    signal,
    stream,
  ) => {
    const resolvedCommand = { ...command, ...toolSettings(command) };
    const result = await executeResolvedResult(resolvedCommand, {
      ...(signal === undefined ? {} : { signal }),
      ...(stream === undefined ? {} : { stream }),
    });
    return isRunnerAgentToolName(resolvedCommand.tool)
      ? retainToolResultOverflow(result, resolvedCommand)
      : result;
  };

  const executeResolvedResult = async (
    command: ResolvedRunnerToolCommand,
    options: {
      readonly signal?: AbortSignal;
      readonly stream?: NonNullable<RunnerToolExecutionOptions["stream"]>;
    },
  ): Promise<RunnerCommandResult> => {
    const { signal, stream } = options;
    try {
      if (command.tool === RUNNER_DIRECTORY_COMMAND) {
        return {
          output: JSON.stringify(
            await listRunnerDirectories(command.workingDirectory),
          ),
          state: "completed",
        };
      }
      if (command.tool === RUNNER_EXECUTION_CLEANUP_COMMAND) {
        const terminal =
          command.arguments[RUNNER_TERMINAL_CLEANUP_ARGUMENT] === true;
        if (command.executionEnvironment === "container") {
          await containers.cleanupSession(command.sessionId);
        }
        return {
          output: terminal
            ? "Session execution resources removed."
            : "Container execution environment removed.",
          state: "completed",
        };
      }
      const attachment = await executeAttachmentCommand(
        command.workingDirectory,
        command.tool,
        command.arguments,
      );
      if (attachment !== undefined) {
        return { output: attachment, state: "completed" };
      }
      if (command.executionEnvironment === "container") {
        return await executeContainer(command, signal, stream);
      }
      if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
        return await agentFileResult(
          command.workingDirectory,
          command.arguments,
        );
      }
      return await executeRunnerToolResult(
        command.workingDirectory,
        command.tool,
        command.arguments,
        signal,
        undefined,
        toolOptions(command, stream),
      );
    } catch (error) {
      return failedRunnerCommandResult(error);
    }
  };

  const executeContainer = async (
    command: ResolvedRunnerToolCommand,
    signal: AbortSignal | undefined,
    stream: NonNullable<RunnerToolExecutionOptions["stream"]> | undefined,
  ): Promise<RunnerCommandResult> => {
    const root = await resolveRunnerWorkspace(command.workingDirectory);
    await containers.prepare(command.sessionId, root, signal);
    if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
      return agentFileResult(root, command.arguments, true);
    }
    const shell: NonNullable<RunnerToolExecutionOptions["shell"]> = async (
      _workspace,
      shellCommand,
      timeoutSeconds,
      shellSignal,
      shellStream,
    ) =>
      runnerCommandResultFromOutput(
        await containers.executeShell(
          command.sessionId,
          root,
          shellCommand,
          timeoutSeconds,
          {
            ...(shellStream === undefined ? {} : { publish: shellStream }),
            outputLimitCharacters: command.outputLimitCharacters,
            ...(shellSignal === undefined ? {} : { signal: shellSignal }),
          },
        ),
      );
    return executeRunnerToolResult(
      root,
      command.tool,
      command.arguments,
      signal,
      undefined,
      {
        ...toolOptions(command, stream),
        containPaths: true,
        mapAbsolutePath: (path) => mapContainerPath(root, path),
        shell,
      },
    );
  };

  const toolOptions = (
    command: ResolvedRunnerToolCommand,
    stream: NonNullable<RunnerToolExecutionOptions["stream"]> | undefined,
  ): RunnerToolExecutionOptions => {
    return {
      executionLimitSeconds: command.executionLimitSeconds,
      outputLimitCharacters: command.outputLimitCharacters,
      ...(stream === undefined ? {} : { stream }),
    };
  };

  const execute = async (
    command: RunnerToolCommand,
    signal?: AbortSignal,
  ): Promise<string> => {
    return (await executeResult(command, signal)).output;
  };
  return { execute, executeResult };
}
