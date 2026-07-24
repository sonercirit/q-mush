import {
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import {
  readAgentSessionToolNames,
  type SessionAgentToolName,
} from "../shared/agent-tools.ts";
import {
  failedRunnerCommandResult,
  type RunnerCommandResult,
} from "../shared/runner-command-broker.ts";
import { MAXIMUM_RUNNER_PATH_LENGTH } from "../shared/runner-directory-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { readIdentifier, readStringField } from "./session-request-helpers.ts";

const MAXIMUM_SESSION_MESSAGE_LENGTH = 32_768;

export interface SpawnSessionToolInput {
  readonly tools: NonNullable<ReturnType<typeof readAgentSessionToolNames>>;
  readonly images: readonly AgentImage[];
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly provider: "openai" | "openrouter";
  readonly workingDirectory: string;
  readonly credentialId: string;
  readonly runnerId: string;
  readonly prompt: string;
  readonly model: string;
}

export interface SessionAgentToolActions {
  readonly continueSession: (sessionId: string) => Promise<string>;
  readonly listSessions: () => string;
  readonly readSession: (sessionId: string) => string;
  readonly sendToSession: (
    sessionId: string,
    message: string,
  ) => Promise<string>;
  readonly spawnSession: (input: SpawnSessionToolInput) => Promise<string>;
  readonly stopSession: (sessionId: string) => string;
}

function sessionId(arguments_: Readonly<Record<string, unknown>>): string {
  const id = readIdentifier(arguments_["sessionId"]);
  if (id === undefined) {
    throw new Error("Tool argument sessionId is invalid");
  }
  return id;
}

function spawnInput(
  arguments_: Readonly<Record<string, unknown>>,
): SpawnSessionToolInput {
  const credentialId = readIdentifier(arguments_["credentialId"]);
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
  const workingDirectory = readStringField(
    arguments_,
    "workingDirectory",
    MAXIMUM_RUNNER_PATH_LENGTH,
    { trim: true },
  );

  if (
    credentialId === undefined ||
    model === undefined ||
    prompt === undefined ||
    (provider !== "openai" && provider !== "openrouter") ||
    (reasoningEffort !== undefined &&
      !isAgentReasoningEffort(reasoningEffort)) ||
    runnerId === undefined ||
    tools === undefined ||
    workingDirectory === undefined ||
    workingDirectory.includes("\0")
  ) {
    throw new Error("The spawn_session arguments are invalid");
  }

  return {
    credentialId,
    images: [],
    model,
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
  if (value === undefined) {
    throw new Error("Tool argument message is invalid");
  }
  return value;
}

function completedToolOutput(output: string): RunnerCommandResult {
  return { output, state: "completed" };
}

function failedToolOutput(error: unknown): RunnerCommandResult {
  return failedRunnerCommandResult(error, 500);
}

export function executeSessionAgentTool(
  actions: SessionAgentToolActions,
  name: SessionAgentToolName,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<RunnerCommandResult> {
  try {
    let output: Promise<string>;
    switch (name) {
      case "continue_session":
        output = actions.continueSession(sessionId(arguments_));
        break;
      case "list_sessions":
        if (Object.keys(arguments_).length > 0) {
          throw new Error("list_sessions does not accept arguments");
        }
        output = Promise.resolve(actions.listSessions());
        break;
      case "read_session":
        output = Promise.resolve(actions.readSession(sessionId(arguments_)));
        break;
      case "send_to_session":
        output = actions.sendToSession(
          sessionId(arguments_),
          message(arguments_),
        );
        break;
      case "spawn_session":
        output = actions.spawnSession(spawnInput(arguments_));
        break;
      case "stop_session":
        output = Promise.resolve(actions.stopSession(sessionId(arguments_)));
        break;
    }
    return output.then(completedToolOutput, failedToolOutput);
  } catch (error) {
    return Promise.resolve(failedToolOutput(error));
  }
}

export function sessionToolOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function lastSessionMessage(
  detail: AgentSessionDetail,
): AgentSessionDetail["messages"][number] | undefined {
  return detail.messages.findLast(({ role }) => role !== "thinking");
}
