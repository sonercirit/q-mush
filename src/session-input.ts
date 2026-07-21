import {
  defaultAgentModel,
  isAgentModelId,
  isAgentReasoningEffort,
} from "./agent-configuration.ts";
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

export function readCreateSession(
  value: unknown,
): CreateSessionInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const credentialId = readIdentifier(value["credentialId"]);
  const provider = readProvider(value["provider"]);
  const runnerId = readIdentifier(value["runnerId"]);
  const prompt = readStringField(value, "prompt", MAXIMUM_PROMPT_LENGTH, {
    trim: true,
  });
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
    provider === undefined ||
    runnerId === undefined ||
    prompt === undefined ||
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
    model: typeof modelValue === "string" ? modelValue : "",
    prompt,
    provider,
    reasoningEffort: isAgentReasoningEffort(reasoningEffortValue)
      ? reasoningEffortValue
      : null,
    runnerId,
    workingDirectory,
  };
}

export function readPrompt(value: unknown): string | undefined {
  return readStringField(value, "prompt", MAXIMUM_PROMPT_LENGTH, {
    trim: true,
  });
}

export function selectedSessionModel(
  input: Pick<CreateSessionInput, "model" | "provider">,
  source: Parameters<typeof defaultAgentModel>[1],
): string {
  return input.model.length === 0
    ? defaultAgentModel(input.provider, source)
    : input.model;
}
