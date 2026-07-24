import {
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { readAgentFile } from "../shared/agent-file.ts";
import { readAgentImages } from "../shared/agent-images.ts";
import { readAgentToolCalls } from "../shared/agent-loop.ts";
import { readAgentSessionToolNames } from "../shared/agent-tools.ts";
import { isRecord, readNullableString } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  readProviderModelPricing,
  type ProviderModelPricing,
} from "../shared/provider-model-pricing.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";

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

  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("The server returned invalid model modalities");
  }

  const items: readonly unknown[] = value;
  return items.map((item) => String(item));
}

function readPositiveSafeInteger(value: unknown): number | null {
  if (typeof value !== "number" || value <= 0) {
    return null;
  }

  return Number.isSafeInteger(value) ? value : null;
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

  const contextWindowValue =
    value["contextWindow"] === undefined
      ? value["context_window"]
      : value["contextWindow"];
  const contextWindow = readPositiveSafeInteger(contextWindowValue);
  const id = value["id"];
  const inputModalitiesValue = value["inputModalities"];
  const label = value["label"];
  const outputModalitiesValue = value["outputModalities"];
  const pricingValue = value["pricing"];

  if (
    !isAgentModelId(id) ||
    inputModalitiesValue === undefined ||
    typeof label !== "string" ||
    outputModalitiesValue === undefined ||
    pricingValue === undefined ||
    (contextWindowValue !== null && contextWindow === null)
  ) {
    throw new Error("The server returned an invalid agent model");
  }

  return {
    contextWindow,
    id,
    inputModalities: readModelModalities(inputModalitiesValue),
    label,
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

function readStatus(value: unknown): AgentSessionStatus | undefined {
  switch (value) {
    case "failed":
    case "idle":
    case "queued":
    case "running":
    case "stopped":
      return value;
    default:
      return undefined;
  }
}

function readProvider(value: unknown): ProviderId | undefined {
  switch (value) {
    case "openai":
    case "openrouter":
      return value;
    default:
      return undefined;
  }
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function requiredStringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The server returned an invalid agent session");
  }
  return value;
}

function readSummary(value: unknown): AgentSessionSummary {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid agent session");
  }

  const activeDurationMs = readFiniteNumber(value["activeDurationMs"]);
  const activeStartedAtValue = value["activeStartedAt"];
  const activeStartedAt =
    activeStartedAtValue === null
      ? null
      : readFiniteNumber(activeStartedAtValue);
  let providerPricing: ProviderModelPricing | null;
  try {
    providerPricing = readModelPricing(value["providerPricing"]);
  } catch {
    throw new Error("The server returned an invalid agent session");
  }
  const autoCompact = value["autoCompact"];
  const costBasis = value["costBasis"];
  const costUsd = readFiniteNumber(value["costUsd"]);
  const createdAt = readFiniteNumber(value["createdAt"]);
  const credentialId = value["credentialId"];
  const currentContextTokens = readFiniteNumber(value["currentContextTokens"]);
  const id = value["id"];
  const maxContextTokens = value["maxContextTokens"];
  const model = value["model"];
  const provider = readProvider(value["provider"]);
  const reasoningEffort = readNullableString(value["reasoningEffort"]);
  const runnerId = value["runnerId"];
  const status = readStatus(value["status"]);
  const title = value["title"];
  const tools = readAgentSessionToolNames(value["tools"]);
  const updatedAt = readFiniteNumber(value["updatedAt"]);
  const workingDirectory = value["workingDirectory"];
  const workspaceId = requiredStringValue(value["workspaceId"]);

  if (
    activeDurationMs === undefined ||
    activeDurationMs < 0 ||
    !Number.isSafeInteger(activeDurationMs) ||
    activeStartedAt === undefined ||
    (activeStartedAt !== null && !Number.isSafeInteger(activeStartedAt)) ||
    typeof autoCompact !== "boolean" ||
    (costBasis !== "none" &&
      costBasis !== "reported" &&
      costBasis !== "estimated") ||
    costUsd === undefined ||
    costUsd < 0 ||
    (costBasis === "none" && costUsd !== 0) ||
    createdAt === undefined ||
    typeof credentialId !== "string" ||
    currentContextTokens === undefined ||
    currentContextTokens < 0 ||
    !Number.isSafeInteger(currentContextTokens) ||
    typeof id !== "string" ||
    (maxContextTokens !== null &&
      (typeof maxContextTokens !== "number" ||
        !Number.isSafeInteger(maxContextTokens) ||
        maxContextTokens <= 0)) ||
    typeof model !== "string" ||
    provider === undefined ||
    value["providerPricing"] === undefined ||
    reasoningEffort === undefined ||
    (reasoningEffort !== null && !isAgentReasoningEffort(reasoningEffort)) ||
    typeof runnerId !== "string" ||
    status === undefined ||
    typeof title !== "string" ||
    tools === undefined ||
    updatedAt === undefined ||
    typeof workingDirectory !== "string" ||
    typeof workspaceId !== "string"
  ) {
    throw new Error("The server returned an invalid agent session");
  }

  return {
    activeDurationMs,
    activeStartedAt,
    autoCompact,
    costBasis,
    costUsd,
    createdAt,
    credentialId,
    currentContextTokens,
    id,
    maxContextTokens,
    model,
    provider,
    providerPricing,
    reasoningEffort,
    runnerId,
    status,
    title,
    tools,
    updatedAt,
    workingDirectory,
    workspaceId,
  };
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

function readMessage(value: unknown): AgentSessionMessage {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid session message");
  }

  const content = value["content"];
  const createdAt = readFiniteNumber(value["createdAt"]);
  const id = value["id"];
  const images = readAgentImages(value["images"]);
  const role = value["role"];
  const toolCallId = readNullableString(value["toolCallId"]);
  const toolName = readNullableString(value["toolName"]);

  if (
    typeof content !== "string" ||
    createdAt === undefined ||
    typeof id !== "string" ||
    images === undefined ||
    (role !== "user" &&
      role !== "assistant" &&
      role !== "tool" &&
      role !== "thinking" &&
      role !== "system" &&
      role !== "error") ||
    toolCallId === undefined ||
    toolName === undefined
  ) {
    throw new Error("The server returned an invalid session message");
  }

  return {
    content,
    createdAt,
    id,
    images,
    role,
    toolCallId,
    toolCalls: readToolCalls(value["toolCalls"]),
    toolName,
  };
}

export function readSessionDetail(value: unknown): AgentSessionDetail {
  if (!isRecord(value) || !Array.isArray(value["messages"])) {
    throw new Error("The server returned invalid agent session details");
  }

  return {
    ...readSummary(value),
    agentFile: readAgentFile(value["agentFile"]),
    messages: value["messages"].map(readMessage),
  };
}

export function readSessionList(
  value: unknown,
): readonly AgentSessionSummary[] {
  if (!isRecord(value) || !Array.isArray(value["sessions"])) {
    throw new Error("The server returned an invalid agent session list");
  }

  return value["sessions"].map(readSummary);
}

export function summaryFromDetail(
  detail: AgentSessionDetail,
): AgentSessionSummary {
  return {
    activeDurationMs: detail.activeDurationMs,
    activeStartedAt: detail.activeStartedAt,
    autoCompact: detail.autoCompact,
    costBasis: detail.costBasis,
    costUsd: detail.costUsd,
    createdAt: detail.createdAt,
    credentialId: detail.credentialId,
    currentContextTokens: detail.currentContextTokens,
    id: detail.id,
    maxContextTokens: detail.maxContextTokens,
    model: detail.model,
    provider: detail.provider,
    providerPricing: detail.providerPricing,
    reasoningEffort: detail.reasoningEffort,
    runnerId: detail.runnerId,
    status: detail.status,
    title: detail.title,
    tools: detail.tools,
    updatedAt: detail.updatedAt,
    workingDirectory: detail.workingDirectory,
    workspaceId: detail.workspaceId,
  };
}
