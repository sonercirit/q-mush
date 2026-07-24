import { isAbsolute, relative, resolve } from "node:path";
import { RUNNER_AGENT_FILE_COMMAND } from "../shared/agent-file.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  readRunnerExecutionEnvironment,
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  type RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import { RUNNER_DIRECTORY_COMMAND } from "../shared/runner-directory-model.ts";
import { loadRunnerAgentFile } from "./runner-agent-file.ts";
import { RunnerContainerManager } from "./runner-container.ts";
import { listRunnerDirectories } from "./runner-directories.ts";
import { executeRunnerTool } from "./runner-tools.ts";
import { resolveRunnerWorkspace } from "./runner-workspace.ts";

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
  const executionEnvironment = readRunnerExecutionEnvironment(
    command["executionEnvironment"],
  );
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

export class RunnerCommandExecutor {
  readonly #containers: RunnerContainerCommands;

  constructor(containers?: RunnerContainerCommands) {
    this.#containers = containers ?? new RunnerContainerManager();
  }

  async execute(
    command: RunnerToolCommand,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      if (command.tool === RUNNER_DIRECTORY_COMMAND) {
        return JSON.stringify(
          await listRunnerDirectories(command.workingDirectory),
        );
      }

      if (command.tool === RUNNER_EXECUTION_CLEANUP_COMMAND) {
        await this.#containers.cleanupSession(command.sessionId);
        return "Container execution environment removed.";
      }

      if (command.executionEnvironment === "container") {
        const root = await resolveRunnerWorkspace(command.workingDirectory);
        await this.#containers.prepare(command.sessionId, root, signal);
        if (command.tool === RUNNER_AGENT_FILE_COMMAND) {
          return JSON.stringify(await loadRunnerAgentFile(root));
        }
        const shell = (
          _workspace: string,
          shellCommand: string,
          timeoutSeconds: number,
          shellSignal?: AbortSignal,
        ): Promise<string> =>
          this.#containers.executeShell(
            command.sessionId,
            root,
            shellCommand,
            timeoutSeconds,
            shellSignal,
          );
        return await executeRunnerTool(
          root,
          command.tool,
          command.arguments,
          signal,
          undefined,
          {
            mapAbsolutePath: (path) => mapContainerPath(root, path),
            shell,
          },
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
}
