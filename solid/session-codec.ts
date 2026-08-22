import {
  isAgentModelId,
  isAgentReasoningEffort,
  isOpenRouterProviderTag,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentReasoningEffort,
  type OpenRouterProviderCatalog,
} from "../shared/agent-configuration.ts";
import { readAgentFile } from "../shared/agent-file.ts";
import { readAgentToolCalls } from "../shared/agent-loop.ts";
import {
  readPendingAskQuestions,
  type PendingAskQuestions,
} from "../shared/ask-questions.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  readProviderModelPricing,
  type ProviderModelPricing,
} from "../shared/provider-model-pricing.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionTurn,
} from "../shared/session-model.ts";
import { readToolSettings } from "../shared/tool-limits.ts";
import {
  isNullOrPositiveSafeInteger,
  readFiniteNumber,
  readNonNegativeSafeInteger,
  readPositiveSafeInteger,
  stringArray,
} from "../shared/validation.ts";
import { readSessionContentFields } from "./session-message-codec.ts";
import { decodedSessionMessage } from "./session-message-decoder.ts";
import { readSessionSummary } from "./session-summary-codec.ts";
import { readTokenUsageSummary } from "./session-usage-codec.ts";

function readModelReasoningEfforts(
  value: unknown,
): readonly AgentReasoningEffort[] {
  if (!Array.isArray(value) || !value.every(isAgentReasoningEffort)) {
    throw new Error("The server returned invalid model reasoning efforts");
  }

  return value;
}

function readModelModalities(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }

  const items = stringArray(value);
  if (items === undefined || items.some((item) => item.length === 0)) {
    throw new Error("The server returned invalid model modalities");
  }

  return items;
}

function readModelPricing(value: unknown): ProviderModelPricing | null {
  const pricing = readProviderModelPricing(value);
  if (pricing === undefined) {
    throw new Error("The server returned invalid model pricing");
  }
  return pricing;
}

function readModelOption(value: unknown): AgentModelOption {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid agent model");
  }

  const adaptiveThinkingValue = value["adaptiveThinking"];
  const contextWindowValue =
    value["contextWindow"] === undefined
      ? value["context_window"]
      : value["contextWindow"];
  const contextWindow = readPositiveSafeInteger(contextWindowValue);
  const fallbackPromptValue = value["fallbackPrompt"];
  const id = value["id"];
  const inputModalitiesValue = value["inputModalities"];
  const label = value["label"];
  const outputModalitiesValue = value["outputModalities"];
  const pricingValue = value["pricing"];

  if (
    (adaptiveThinkingValue !== null &&
      typeof adaptiveThinkingValue !== "boolean") ||
    !isAgentModelId(id) ||
    (fallbackPromptValue !== undefined &&
      fallbackPromptValue !== null &&
      typeof fallbackPromptValue !== "string") ||
    inputModalitiesValue === undefined ||
    typeof label !== "string" ||
    outputModalitiesValue === undefined ||
    pricingValue === undefined ||
    (contextWindowValue !== null && contextWindow === null)
  ) {
    throw new Error("The server returned an invalid agent model");
  }

  const maxOutputTokens = value["maxOutputTokens"];
  if (!isNullOrPositiveSafeInteger(maxOutputTokens)) {
    throw new Error("The server returned an invalid agent model");
  }
  return {
    adaptiveThinking: adaptiveThinkingValue,
    contextWindow,
    fallbackPrompt:
      typeof fallbackPromptValue === "string" ? fallbackPromptValue : null,
    id,
    inputModalities: readModelModalities(inputModalitiesValue),
    label,
    maxOutputTokens,
    outputModalities: readModelModalities(outputModalitiesValue),
    pricing: readModelPricing(pricingValue),
    reasoningEfforts: readModelReasoningEfforts(value["reasoningEfforts"]),
  };
}

export function readAgentModelCatalog(value: unknown): AgentModelCatalog {
  if (!isRecord(value) || !Array.isArray(value["models"])) {
    throw new Error("The server returned an invalid agent model catalog");
  }

  const defaultModel = value["defaultModel"];
  const models = value["models"].map(readModelOption);

  if (
    (defaultModel !== null && !isAgentModelId(defaultModel)) ||
    (typeof defaultModel === "string" &&
      !models.some(({ id }) => id === defaultModel))
  ) {
    throw new Error("The server returned an invalid agent model catalog");
  }

  return { defaultModel, models };
}

export function readOpenRouterProviderCatalog(
  value: unknown,
): OpenRouterProviderCatalog {
  if (
    !isRecord(value) ||
    !Array.isArray(value["providers"]) ||
    value["providers"].length > 200
  ) {
    throw new Error("The server returned invalid OpenRouter providers");
  }
  const tags = new Set<string>();
  const providers = value["providers"].map((provider) => {
    if (!isRecord(provider)) {
      throw new Error("The server returned an invalid OpenRouter provider");
    }
    const contextWindow = readPositiveSafeInteger(provider["contextWindow"]);
    const name = provider["name"];
    const tag = provider["tag"];
    if (
      (provider["contextWindow"] !== null && contextWindow === null) ||
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 120 ||
      !isOpenRouterProviderTag(tag) ||
      tags.has(tag)
    ) {
      throw new Error("The server returned an invalid OpenRouter provider");
    }
    tags.add(tag);
    return {
      contextWindow,
      name,
      pricing: readModelPricing(provider["pricing"]),
      tag,
    };
  });
  return { providers };
}

function readToolCalls(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("The server returned invalid session tool calls");
  }

  return readAgentToolCalls(
    value,
    "The server returned an invalid session tool call",
  );
}

function readTurn(value: unknown): AgentSessionTurn {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid agent session turn");
  }
  const boundaryMessageId =
    value["boundaryMessageId"] === null
      ? null
      : typeof value["boundaryMessageId"] === "string"
        ? value["boundaryMessageId"]
        : undefined;
  const endedAt =
    value["endedAt"] === null ? null : readFiniteNumber(value["endedAt"]);
  const executionGeneration = readNonNegativeSafeInteger(
    value["executionGeneration"],
  );
  const startedAt = readFiniteNumber(value["startedAt"]);
  const toolSettings = readToolSettings(value["toolSettings"]);
  if (
    boundaryMessageId === undefined ||
    endedAt === undefined ||
    executionGeneration === undefined ||
    typeof value["id"] !== "string" ||
    startedAt === undefined ||
    toolSettings === undefined ||
    !Number.isSafeInteger(startedAt) ||
    (endedAt !== null &&
      (!Number.isSafeInteger(endedAt) || endedAt < startedAt))
  ) {
    throw new Error("The server returned an invalid agent session turn");
  }
  return {
    boundaryMessageId,
    endedAt,
    executionGeneration,
    id: value["id"],
    startedAt,
    toolSettings,
  };
}

function readMessage(value: unknown): AgentSessionMessage {
  const invalidMessage = "The server returned an invalid session message";
  const { fields, record, role } = decodedSessionMessage(value, invalidMessage);

  return {
    ...fields,
    role,
    toolCalls: readToolCalls(record["toolCalls"]),
  };
}

export function readSessionPendingInput(
  value: unknown,
): AgentSessionDetail["pendingInputs"][number] {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid pending session input");
  }
  const clientRequestId = value["clientRequestId"];
  const fields = readSessionContentFields(value);
  const kind = value["kind"];
  if (
    typeof clientRequestId !== "string" ||
    fields === undefined ||
    (kind !== "follow_up" && kind !== "steer")
  ) {
    throw new Error("The server returned an invalid pending session input");
  }
  return { ...fields, clientRequestId, kind };
}

export function readSessionPendingQuestions(
  value: unknown,
): PendingAskQuestions | null {
  if (value === null) {
    return null;
  }
  const pending = readPendingAskQuestions(value);
  if (pending === undefined) {
    throw new Error("The server returned invalid pending questions");
  }
  return pending;
}

export function readSessionDetail(value: unknown): AgentSessionDetail {
  if (
    !isRecord(value) ||
    !Array.isArray(value["messages"]) ||
    !Array.isArray(value["pendingInputs"]) ||
    (value["turns"] !== undefined && !Array.isArray(value["turns"]))
  ) {
    throw new Error("The server returned invalid agent session details");
  }

  const modelContextTokens = value["modelContextTokens"];
  const segmentTokenUsage = readTokenUsageSummary(value["segmentTokenUsage"]);
  const tokenUsage = readTokenUsageSummary(value["tokenUsage"]);
  if (
    !isNullOrPositiveSafeInteger(modelContextTokens) ||
    segmentTokenUsage === undefined ||
    tokenUsage === undefined
  ) {
    throw new Error("The server returned invalid agent session details");
  }
  return {
    ...readSessionSummary(value),
    agentFile: readAgentFile(value["agentFile"]),
    messages: value["messages"].map(readMessage),
    modelContextTokens,
    pendingInputs: value["pendingInputs"].map(readSessionPendingInput),
    ...(segmentTokenUsage === null ? {} : { segmentTokenUsage }),
    ...(tokenUsage === null ? {} : { tokenUsage }),
    ...(Array.isArray(value["turns"])
      ? { turns: value["turns"].map(readTurn) }
      : {}),
  };
}
