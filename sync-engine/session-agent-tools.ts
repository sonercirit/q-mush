import {
  isAgentModelId,
  isAgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import {
  readAgentSessionToolNames,
  type SessionAgentToolName,
} from "../shared/agent-tools.ts";
import { isProviderId } from "../shared/provider-credential-store.ts";
import { MAXIMUM_RUNNER_PATH_LENGTH } from "../shared/runner-directory-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { GetSessionOptionsToolInput } from "./session-agent-options.ts";
import type { ReadSessionToolInput } from "./session-agent-read.ts";
import {
  getSessionOptionsToolInput,
  hasOnlySessionToolArguments,
  readSessionToolInput,
} from "./session-agent-tool-input.ts";
import { readIdentifier, readStringField } from "./session-request-helpers.ts";

const MAXIMUM_SESSION_MESSAGE_LENGTH = 32_768;

export interface SpawnSessionToolInput extends Pick<
  AgentSessionDetail,
  | "credentialId"
  | "model"
  | "provider"
  | "reasoningEffort"
  | "runnerId"
  | "tools"
  | "workingDirectory"
> {
  readonly images: readonly AgentImage[];
  readonly prompt: string;
}

export interface SessionAgentToolActions {
  readonly continueSession: (sessionId: string) => Promise<string>;
  readonly getSessionOptions: (
    input: GetSessionOptionsToolInput,
  ) => Promise<string>;
  readonly listSessions: () => string;
  readonly readSession: (input: ReadSessionToolInput) => string;
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
    !hasOnlySessionToolArguments(arguments_, [
      "credentialId",
      "model",
      "prompt",
      "provider",
      "reasoningEffort",
      "runnerId",
      "tools",
      "workingDirectory",
    ]) ||
    credentialId === undefined ||
    model === undefined ||
    prompt === undefined ||
    !isProviderId(provider) ||
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
  if (
    !hasOnlySessionToolArguments(arguments_, ["sessionId", "message"]) ||
    value === undefined
  ) {
    throw new Error("Tool argument message is invalid");
  }
  return value;
}

function safeToolError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Error: ${detail.slice(0, 500)}`;
}

export function executeSessionAgentTool(
  actions: SessionAgentToolActions,
  name: SessionAgentToolName,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  try {
    let output: Promise<string>;
    switch (name) {
      case "continue_session":
        if (!hasOnlySessionToolArguments(arguments_, ["sessionId"])) {
          throw new Error("continue_session received invalid arguments");
        }
        output = actions.continueSession(sessionId(arguments_));
        break;
      case "get_session_options":
        output = actions.getSessionOptions(
          getSessionOptionsToolInput(arguments_),
        );
        break;
      case "list_sessions":
        if (Object.keys(arguments_).length > 0) {
          throw new Error("list_sessions does not accept arguments");
        }
        output = Promise.resolve(actions.listSessions());
        break;
      case "read_session":
        output = Promise.resolve(
          actions.readSession(readSessionToolInput(arguments_)),
        );
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
        if (!hasOnlySessionToolArguments(arguments_, ["sessionId"])) {
          throw new Error("stop_session received invalid arguments");
        }
        output = Promise.resolve(actions.stopSession(sessionId(arguments_)));
        break;
    }
    return output.catch((error: unknown) => safeToolError(error));
  } catch (error) {
    return Promise.resolve(safeToolError(error));
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
