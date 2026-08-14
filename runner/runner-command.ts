import { isAbsolute, relative, resolve } from "node:path";
import {
  readAgentFilePath,
  RUNNER_AGENT_FILE_COMMAND,
  RUNNER_AGENT_FILE_PATH_ARGUMENT,
} from "../shared/agent-file.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  failedRunnerCommandResult,
  readRunnerExecutionEnvironment,
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  RUNNER_TOOL_OUTPUT_SPILL_COMMAND,
  RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT,
  type RunnerCommandArguments,
  type RunnerCommandResult,
  type RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import { RUNNER_DIRECTORY_COMMAND } from "../shared/runner-directory-model.ts";
import { readBoundedString } from "../shared/validation.ts";
import { loadRunnerAgentFile } from "./runner-agent-file.ts";
import { executeAttachmentCommand } from "./runner-attachments.ts";
import { RunnerContainerManager } from "./runner-container.ts";
import { listRunnerDirectories } from "./runner-directories.ts";
import { RunnerOutputSpills } from "./runner-output-spills.ts";
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
  const value = record[key];
  return readBoundedString(value, maximumLength);
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
  const sessionId = recordString(
    command,
    "sessionId",
    MAXIMUM_IDENTIFIER_LENGTH,
  );
  const tool = recordString(command, "tool", MAXIMUM_TOOL_NAME_LENGTH);
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
    id,
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
  if (path === "/workspace") {
    return root;
  }
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
  return new RunnerCommandExecutor().execute(command, signal);
}

export class RunnerCommandExecutor {
  readonly #containers: RunnerContainerCommands;
  readonly #outputSpills = new Map<string, RunnerOutputSpills>();

  constructor(containers?: RunnerContainerCommands) {
    this.#containers = containers ?? new RunnerContainerManager();
  }

  #outputSpill(sessionId: string): RunnerOutputSpills {
    const existing = this.#outputSpills.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new RunnerOutputSpills();
    this.#outputSpills.set(sessionId, created);
    return created;
  }

  async #cleanupOutputSpill(sessionId: string): Promise<void> {
    const spill = this.#outputSpills.get(sessionId);
    this.#outputSpills.delete(sessionId);
    await spill?.cleanup();
  }

  async executeResult(
    command: RunnerToolCommand,
    signal?: AbortSignal,
    stream?: NonNullable<RunnerToolExecutionOptions["stream"]>,
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

      if (command.tool === RUNNER_EXECUTION_CLEANUP_COMMAND) {
        const terminalCleanup =
          command.arguments[RUNNER_TERMINAL_CLEANUP_ARGUMENT] === true;
        const cleanupOutputSpill = terminalCleanup
          ? this.#cleanupOutputSpill(command.sessionId)
          : Promise.resolve();
        const cleanupContainer =
          command.executionEnvironment === "container"
            ? this.#containers.cleanupSession(command.sessionId)
            : Promise.resolve();
        await Promise.all([cleanupContainer, cleanupOutputSpill]);
        return {
          output: terminalCleanup
            ? "Session execution resources removed."
            : "Container execution environment removed.",
          state: "completed",
        };
      }

      if (command.tool === RUNNER_TOOL_OUTPUT_SPILL_COMMAND) {
        const content =
          command.arguments[RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT];
        if (typeof content !== "string") {
          throw new Error("The tool output spill content is invalid");
        }
        return {
          output: await this.#outputSpill(command.sessionId).spill(content),
          state: "completed",
        };
      }

      const attachmentResult = await executeAttachmentCommand(
        command.workingDirectory,
        command.tool,
        command.arguments,
      );
      if (attachmentResult !== undefined) {
        return { output: attachmentResult, state: "completed" };
      }

      if (command.executionEnvironment === "container") {
        const root = await resolveRunnerWorkspace(command.workingDirectory);
        await this.#containers.prepare(command.sessionId, root, signal);
        if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
          return await agentFileResult(root, command.arguments, true);
        }
        const shell = async (
          _workspace: string,
          shellCommand: string,
          timeoutSeconds: number,
          shellSignal?: AbortSignal,
          shellStream?: NonNullable<RunnerToolExecutionOptions["stream"]>,
        ): Promise<RunnerCommandResult> => {
          const output = await this.#containers.executeShell(
            command.sessionId,
            root,
            shellCommand,
            timeoutSeconds,
            shellSignal,
            shellStream,
          );
          return runnerCommandResultFromOutput(output);
        };
        return await executeRunnerToolResult(
          root,
          command.tool,
          command.arguments,
          signal,
          undefined,
          {
            containPaths: true,
            mapAbsolutePath: (path) => mapContainerPath(root, path),
            outputSpills: this.#outputSpill(command.sessionId),
            shell,
            ...(stream === undefined ? {} : { stream }),
          },
        );
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
        stream === undefined
          ? { outputSpills: this.#outputSpill(command.sessionId) }
          : { outputSpills: this.#outputSpill(command.sessionId), stream },
      );
    } catch (error) {
      return failedRunnerCommandResult(error, 1_000);
    }
  }

  async execute(
    command: RunnerToolCommand,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.executeResult(command, signal)).output;
  }
}
