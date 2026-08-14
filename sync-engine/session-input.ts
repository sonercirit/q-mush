import { readAgentAttachments } from "../shared/agent-attachments.ts";
import {
  isAgentModelId,
  isAgentReasoningEffort,
  isOpenRouterProviderSelection,
} from "../shared/agent-configuration.ts";
import { readOptionalAgentFilePath } from "../shared/agent-file.ts";
import {
  AGENT_SESSION_TOOL_NAMES,
  readAgentSessionToolNames,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import { isProviderId, type ProviderId } from "../shared/provider-id.ts";
import { readRunnerExecutionEnvironment } from "../shared/runner-command-broker.ts";
import {
  readIdentifier,
  readStringField,
  readWorkingDirectory,
} from "./session-request-helpers.ts";
import type { CreateAgentSession } from "./session-store-create.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;

export type CreateSessionInput = Omit<
  CreateAgentSession,
  | "maxContextTokens"
  | "maxOutputTokens"
  | "parentUserInitiated"
  | "providerPricing"
  | "userId"
  | "workspaceId"
> & { readonly workspaceId?: string };

export function readProvider(value: unknown): ProviderId | undefined {
  return isProviderId(value) ? value : undefined;
}

function promptInput(
  value: Readonly<Record<string, unknown>>,
): PromptInput | undefined {
  const attachments = readAgentAttachments(
    value["attachments"] ?? value["images"],
  );
  const prompt = readStringField(value, "prompt", MAXIMUM_PROMPT_LENGTH, {
    trim: true,
  });
  return attachments === undefined ||
    (prompt === undefined && attachments.length === 0)
    ? undefined
    : { images: attachments, prompt: prompt ?? "" };
}

export function readCreateSession(
  value: unknown,
): CreateSessionInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const credentialId = readIdentifier(value["credentialId"]);
  const agentFilePath = readOptionalAgentFilePath(value["agentFilePath"]);
  const autoCompactValue = value["autoCompact"];
  const idleCompactValue = value["idleCompact"];
  const executionEnvironment = readRunnerExecutionEnvironment(
    value["executionEnvironment"],
  );
  const message = promptInput(value);
  const provider = readProvider(value["provider"]);
  const runnerId = readIdentifier(value["runnerId"]);
  const workingDirectory = readWorkingDirectory(value);
  const modelValue = value["model"];
  const userContextTokenCapValue = value["userContextTokenCap"];
  const openRouterProviderTagValue = value["openRouterProviderTag"];
  const reasoningEffortValue = value["reasoningEffort"];
  const toolsValue = value["tools"];
  const tools =
    toolsValue === undefined
      ? AGENT_SESSION_TOOL_NAMES
      : readAgentSessionToolNames(toolsValue);

  if (
    (autoCompactValue !== undefined && typeof autoCompactValue !== "boolean") ||
    (idleCompactValue !== undefined && typeof idleCompactValue !== "boolean") ||
    agentFilePath === undefined ||
    credentialId === undefined ||
    executionEnvironment === undefined ||
    message === undefined ||
    provider === undefined ||
    runnerId === undefined ||
    workingDirectory === undefined ||
    !isAgentModelId(modelValue) ||
    (userContextTokenCapValue !== undefined &&
      (!Number.isSafeInteger(userContextTokenCapValue) ||
        typeof userContextTokenCapValue !== "number" ||
        userContextTokenCapValue <= 0)) ||
    (openRouterProviderTagValue !== undefined &&
      !isOpenRouterProviderSelection(openRouterProviderTagValue)) ||
    (provider !== "openrouter" && openRouterProviderTagValue !== undefined) ||
    (reasoningEffortValue !== undefined &&
      !isAgentReasoningEffort(reasoningEffortValue)) ||
    tools === undefined
  ) {
    return undefined;
  }

  return {
    agentFilePath,
    autoCompact:
      typeof autoCompactValue === "boolean" ? autoCompactValue : true,
    idleCompact:
      typeof idleCompactValue === "boolean" ? idleCompactValue : false,
    credentialId,
    executionEnvironment,
    ...message,
    model: modelValue,
    openRouterProviderTag: isOpenRouterProviderSelection(
      openRouterProviderTagValue,
    )
      ? openRouterProviderTagValue
      : null,
    provider,
    reasoningEffort: isAgentReasoningEffort(reasoningEffortValue)
      ? reasoningEffortValue
      : null,
    runnerId,
    tools,
    userContextTokenCap:
      typeof userContextTokenCapValue === "number"
        ? userContextTokenCapValue
        : null,
    workingDirectory,
  };
}

export interface UserSpawnSessionInput extends CreateSessionInput {
  readonly parentGeneration: number;
  readonly parentSessionId: string;
}

export function readUserSpawnSession(
  value: unknown,
): UserSpawnSessionInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const spawnValue = { ...value };
  delete spawnValue["parentGeneration"];
  delete spawnValue["parentSessionId"];
  const parentGeneration = value["parentGeneration"];
  const parentSessionId = readIdentifier(value["parentSessionId"]);
  const tools = readAgentSessionToolNames(value["tools"]);
  const session = readCreateSession(spawnValue);
  if (
    !Number.isSafeInteger(parentGeneration) ||
    typeof parentGeneration !== "number" ||
    parentGeneration < 0 ||
    parentSessionId === undefined ||
    tools === undefined ||
    session === undefined
  ) {
    return undefined;
  }
  return { ...session, parentGeneration, parentSessionId, tools };
}

export interface PromptInput {
  readonly attachments?: NonNullable<ReturnType<typeof readAgentAttachments>>;
  readonly images: NonNullable<ReturnType<typeof readAgentAttachments>>;
  readonly prompt: string;
}

export function readPrompt(value: unknown): PromptInput | undefined {
  return isRecord(value) ? promptInput(value) : undefined;
}
