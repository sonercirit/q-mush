import {
  isAgentModelId,
  isAgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { readOptionalAgentFilePath } from "../shared/agent-file.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import {
  readAgentSessionToolNames,
  type SessionAgentToolName,
} from "../shared/agent-tools.ts";
import { isProviderId } from "../shared/provider-id.ts";
import {
  failedRunnerCommandResult,
  readRunnerExecutionEnvironment,
  type RunnerCommandArguments,
} from "../shared/runner-command-broker.ts";
import { MAXIMUM_RUNNER_PATH_LENGTH } from "../shared/runner-directory-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import { completedRunnerCommandResult } from "./runner-command-result.ts";
import type { ListSessionsToolInput } from "./session-agent-list.ts";
import type { GetSessionOptionsToolInput } from "./session-agent-options.ts";
import type { ReadSessionToolInput } from "./session-agent-read.ts";
import {
  getSessionOptionsToolInput,
  hasOnlySessionToolArguments,
  listSessionsToolInput,
  readSessionToolInput,
} from "./session-agent-tool-input.ts";
import {
  readIdentifier,
  readStringField,
  readWorkingDirectory,
} from "./session-request-helpers.ts";

const MAXIMUM_SESSION_MESSAGE_LENGTH = 32_768;

export interface SpawnSessionToolInput extends Pick<
  AgentSessionDetail,
  | "agentFilePath"
  | "autoCompact"
  | "credentialId"
  | "idleCompact"
  | "executionEnvironment"
  | "model"
  | "openRouterProviderTag"
  | "provider"
  | "reasoningEffort"
  | "runnerId"
  | "tools"
  | "workingDirectory"
> {
  readonly images: readonly AgentImage[];
  readonly prompt: string;
}

type SignaledSessionAction<Arguments extends readonly unknown[], Result> = (
  ...arguments_: [...Arguments, signal: AbortSignal]
) => Result;
type SignaledMessageAction = SignaledSessionAction<
  [sessionId: string, message: string],
  Promise<string>
>;

export interface SessionAgentToolActions {
  readonly browseRunnerDirectories: (
    runnerId: string,
    path: string,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly compactSession: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly continueSession: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly getSessionOptions: (
    input: GetSessionOptionsToolInput,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly listRunners: () => string;
  readonly listSessions: (input: ListSessionsToolInput) => string;
  readonly readSession: (input: ReadSessionToolInput) => string;
  readonly reassignSession: (
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
    signal: AbortSignal,
  ) => string;
  readonly sendToSession: SignaledMessageAction;
  readonly spawnSession: (
    input: SpawnSessionToolInput,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly steerSession: SignaledMessageAction;
  readonly stopSession: (
    sessionId: string,
    cascade: boolean,
    signal: AbortSignal,
  ) => string;
}

function sessionId(arguments_: Readonly<Record<string, unknown>>): string {
  const id = readIdentifier(arguments_["sessionId"]);
  if (id === undefined) {
    throw new Error("Tool argument sessionId is invalid");
  }
  return id;
}

function readRunnerPath(
  arguments_: Readonly<Record<string, unknown>>,
): string | undefined {
  return readWorkingDirectory(arguments_);
}

function reassignmentInput(arguments_: Readonly<Record<string, unknown>>): {
  readonly runnerId: string;
  readonly sessionId: string;
  readonly workingDirectory: string;
} {
  const runnerId = readIdentifier(arguments_["runnerId"]);
  const selectedSessionId = sessionId(arguments_);
  const workingDirectory = readRunnerPath(arguments_);
  if (
    !hasOnlySessionToolArguments(arguments_, [
      "sessionId",
      "runnerId",
      "workingDirectory",
    ]) ||
    runnerId === undefined ||
    workingDirectory === undefined
  ) {
    throw new Error("The reassign_session arguments are invalid");
  }
  return { runnerId, sessionId: selectedSessionId, workingDirectory };
}

function spawnInput(
  arguments_: Readonly<Record<string, unknown>>,
): SpawnSessionToolInput {
  const credentialId = readIdentifier(arguments_["credentialId"]);
  const agentFilePath = readOptionalAgentFilePath(arguments_["agentFilePath"]);
  const autoCompact = arguments_["autoCompact"];
  const idleCompact = arguments_["idleCompact"];
  const executionEnvironment = readRunnerExecutionEnvironment(
    arguments_["executionEnvironment"],
  );
  const modelValue = arguments_["model"];
  const model = isAgentModelId(modelValue) ? modelValue : undefined;
  const prompt = readStringField(
    arguments_,
    "prompt",
    MAXIMUM_SESSION_MESSAGE_LENGTH,
    { trim: true },
  );
  const provider = arguments_["provider"];
  const reasoningEffort = arguments_["reasoningEffort"];
  const runnerId = readIdentifier(arguments_["runnerId"]);
  const tools = readAgentSessionToolNames(arguments_["tools"]);
  const workingDirectory = readRunnerPath(arguments_);

  if (
    !hasOnlySessionToolArguments(arguments_, [
      "agentFilePath",
      "autoCompact",
      "credentialId",
      "executionEnvironment",
      "idleCompact",
      "model",
      "prompt",
      "provider",
      "reasoningEffort",
      "runnerId",
      "tools",
      "workingDirectory",
    ]) ||
    (autoCompact !== undefined && typeof autoCompact !== "boolean") ||
    (idleCompact !== undefined && typeof idleCompact !== "boolean") ||
    agentFilePath === undefined ||
    credentialId === undefined ||
    executionEnvironment === undefined ||
    model === undefined ||
    prompt === undefined ||
    !isProviderId(provider) ||
    (reasoningEffort !== undefined &&
      !isAgentReasoningEffort(reasoningEffort)) ||
    runnerId === undefined ||
    tools === undefined ||
    workingDirectory === undefined
  ) {
    throw new Error("The spawn_session arguments are invalid");
  }

  return {
    agentFilePath,
    autoCompact: typeof autoCompact === "boolean" ? autoCompact : true,
    credentialId,
    idleCompact: typeof idleCompact === "boolean" ? idleCompact : false,
    executionEnvironment,
    images: [],
    model,
    openRouterProviderTag: null,
    prompt,
    provider,
    reasoningEffort: isAgentReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : null,
    runnerId,
    tools,
    workingDirectory,
  };
}

function message(arguments_: Readonly<Record<string, unknown>>): string {
  const value = readStringField(
    arguments_,
    "message",
    MAXIMUM_SESSION_MESSAGE_LENGTH,
    { trim: true },
  );
  if (
    !hasOnlySessionToolArguments(arguments_, ["sessionId", "message"]) ||
    value === undefined
  ) {
    throw new Error("Tool argument message is invalid");
  }
  return value;
}

function failedToolOutput(error: unknown): RunnerCommandResult {
  return failedRunnerCommandResult(error);
}

type SessionAgentToolHandler = (
  actions: SessionAgentToolActions,
  arguments_: RunnerCommandArguments,
  signal: AbortSignal,
) => Promise<string>;

const sessionAgentToolHandlers: Record<
  SessionAgentToolName,
  SessionAgentToolHandler
> = {
  sleep: () => {
    throw new Error("sleep requires the active session runtime");
  },
  browse_runner_directories: (actions, arguments_, signal) => {
    const runnerId = readIdentifier(arguments_["runnerId"]);
    const path = readStringField(
      arguments_,
      "path",
      MAXIMUM_RUNNER_PATH_LENGTH,
      {
        trim: true,
      },
    );
    if (
      !hasOnlySessionToolArguments(arguments_, ["runnerId", "path"]) ||
      runnerId === undefined ||
      path === undefined ||
      path.includes("\0")
    ) {
      throw new Error("The browse_runner_directories arguments are invalid");
    }
    return actions.browseRunnerDirectories(runnerId, path, signal);
  },
  compact_session: (actions, arguments_, signal) => {
    if (!hasOnlySessionToolArguments(arguments_, ["sessionId"])) {
      throw new Error("compact_session received invalid arguments");
    }
    return actions.compactSession(sessionId(arguments_), signal);
  },
  continue_session: (actions, arguments_, signal) => {
    if (!hasOnlySessionToolArguments(arguments_, ["sessionId"])) {
      throw new Error("continue_session received invalid arguments");
    }
    return actions.continueSession(sessionId(arguments_), signal);
  },
  get_session_options: (actions, arguments_, signal) =>
    actions.getSessionOptions(getSessionOptionsToolInput(arguments_), signal),
  list_runners: (actions, arguments_) => {
    if (Object.keys(arguments_).length > 0) {
      throw new Error("list_runners does not accept arguments");
    }
    return Promise.resolve(actions.listRunners());
  },
  list_sessions: (actions, arguments_) =>
    Promise.resolve(actions.listSessions(listSessionsToolInput(arguments_))),
  read_session: (actions, arguments_) =>
    Promise.resolve(actions.readSession(readSessionToolInput(arguments_))),
  reassign_session: (actions, arguments_, signal) => {
    const input = reassignmentInput(arguments_);
    return Promise.resolve(
      actions.reassignSession(
        input.sessionId,
        input.runnerId,
        input.workingDirectory,
        signal,
      ),
    );
  },
  send_to_session: (actions, arguments_, signal) =>
    actions.sendToSession(sessionId(arguments_), message(arguments_), signal),
  spawn_session: (actions, arguments_, signal) =>
    actions.spawnSession(spawnInput(arguments_), signal),
  steer_session: (actions, arguments_, signal) =>
    actions.steerSession(sessionId(arguments_), message(arguments_), signal),
  stop_session: (actions, arguments_, signal) => {
    if (!hasOnlySessionToolArguments(arguments_, ["sessionId", "cascade"])) {
      throw new Error("stop_session received invalid arguments");
    }
    const cascade = arguments_["cascade"];
    if (cascade !== undefined && typeof cascade !== "boolean") {
      throw new Error("stop_session received invalid arguments");
    }
    return Promise.resolve(
      actions.stopSession(sessionId(arguments_), cascade ?? true, signal),
    );
  },
};

export function executeSessionAgentTool(
  actions: SessionAgentToolActions,
  name: SessionAgentToolName,
  arguments_: RunnerCommandArguments,
  signal: AbortSignal,
): Promise<RunnerCommandResult> {
  try {
    return sessionAgentToolHandlers[name](actions, arguments_, signal).then(
      completedRunnerCommandResult,
      failedToolOutput,
    );
  } catch (error) {
    return Promise.resolve(failedToolOutput(error));
  }
}

export function sessionToolOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
