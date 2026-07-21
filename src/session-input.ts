import {
  defaultAgentModel,
  isAgentModelId,
  isAgentReasoningEffort,
} from "./agent-configuration.ts";
import { readAgentImages } from "./agent-images.ts";
import { isRecord } from "./auth-model.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import { MAXIMUM_RUNNER_PATH_LENGTH } from "./runner-directory-model.ts";
import { readIdentifier, readStringField } from "./session-request-helpers.ts";
import type { CreateAgentSession } from "./session-store.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;

export type CreateSessionInput = Omit<
  CreateAgentSession,
  "autoCompact" | "maxContextTokens" | "userId"
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
  const workingDirectory = readStringField(
    value,
    "workingDirectory",
    MAXIMUM_RUNNER_PATH_LENGTH,
    { trim: true },
  );
  const modelValue = value["model"];
  const reasoningEffortValue = value["reasoningEffort"];

  if (
    credentialId === undefined ||
    message === undefined ||
    provider === undefined ||
    runnerId === undefined ||
    workingDirectory === undefined ||
    workingDirectory.includes("\0") ||
    (modelValue !== undefined && !isAgentModelId(modelValue)) ||
    (reasoningEffortValue !== undefined &&
      !isAgentReasoningEffort(reasoningEffortValue))
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
