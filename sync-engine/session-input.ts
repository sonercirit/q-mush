import {
  defaultAgentModel,
  isAgentModelId,
  isAgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { readAgentImages } from "../shared/agent-images.ts";
import {
  AGENT_SESSION_TOOL_NAMES,
  readAgentSessionToolNames,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  readIdentifier,
  readStringField,
  readWorkingDirectory,
} from "./session-request-helpers.ts";
import type { CreateAgentSession } from "./session-store-create.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;

export type CreateSessionInput = Omit<
  CreateAgentSession,
  "autoCompact" | "maxContextTokens" | "providerPricing" | "userId"
>;

export function readProvider(value: unknown): ProviderId | undefined {
  return value === "openai" || value === "openrouter" ? value : undefined;
}

function promptInput(
  value: Readonly<Record<string, unknown>>,
): PromptInput | undefined {
  const images = readAgentImages(value["images"]);
  const prompt = readStringField(value, "prompt", MAXIMUM_PROMPT_LENGTH, {
    trim: true,
  });
  return images === undefined || (prompt === undefined && images.length === 0)
    ? undefined
    : { images, prompt: prompt ?? "" };
}

export function readCreateSession(
  value: unknown,
): CreateSessionInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const credentialId = readIdentifier(value["credentialId"]);
  const message = promptInput(value);
  const provider = readProvider(value["provider"]);
  const runnerId = readIdentifier(value["runnerId"]);
  const workingDirectory = readWorkingDirectory(value);
  const modelValue = value["model"];
  const reasoningEffortValue = value["reasoningEffort"];
  const toolsValue = value["tools"];
  const tools =
    toolsValue === undefined
      ? AGENT_SESSION_TOOL_NAMES
      : readAgentSessionToolNames(toolsValue);

  if (
    credentialId === undefined ||
    message === undefined ||
    provider === undefined ||
    runnerId === undefined ||
    workingDirectory === undefined ||
    (modelValue !== undefined && !isAgentModelId(modelValue)) ||
    (reasoningEffortValue !== undefined &&
      !isAgentReasoningEffort(reasoningEffortValue)) ||
    tools === undefined
  ) {
    return undefined;
  }

  return {
    credentialId,
    ...message,
    model: typeof modelValue === "string" ? modelValue : "",
    provider,
    reasoningEffort: isAgentReasoningEffort(reasoningEffortValue)
      ? reasoningEffortValue
      : null,
    runnerId,
    tools,
    workingDirectory,
  };
}

export interface PromptInput {
  readonly images: NonNullable<ReturnType<typeof readAgentImages>>;
  readonly prompt: string;
}

export function readPrompt(value: unknown): PromptInput | undefined {
  return isRecord(value) ? promptInput(value) : undefined;
}

export function selectedSessionModel(
  input: Pick<CreateSessionInput, "model" | "provider">,
  source: Parameters<typeof defaultAgentModel>[1],
): string {
  return input.model.length === 0
    ? defaultAgentModel(input.provider, source)
    : input.model;
}
