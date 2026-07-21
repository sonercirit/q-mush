import {
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "./agent-configuration.ts";
import { readAgentFile } from "./agent-file.ts";
import { readAgentToolCalls } from "./agent-loop.ts";
import { isRecord, readNullableString } from "./auth-model.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionSummary,
} from "./session-model.ts";

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

  if (
    !isAgentModelId(id) ||
    inputModalitiesValue === undefined ||
    typeof label !== "string" ||
    outputModalitiesValue === undefined ||
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

function readSummary(value: unknown): AgentSessionSummary {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid agent session");
  }

  const autoCompact = value["autoCompact"];
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
  const updatedAt = readFiniteNumber(value["updatedAt"]);
  const workingDirectory = value["workingDirectory"];

  if (
    typeof autoCompact !== "boolean" ||
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
    reasoningEffort === undefined ||
    (reasoningEffort !== null && !isAgentReasoningEffort(reasoningEffort)) ||
    typeof runnerId !== "string" ||
    status === undefined ||
    typeof title !== "string" ||
    updatedAt === undefined ||
    typeof workingDirectory !== "string"
  ) {
    throw new Error("The server returned an invalid agent session");
  }

  return {
    autoCompact,
    createdAt,
    credentialId,
    currentContextTokens,
    id,
    maxContextTokens,
    model,
    provider,
    reasoningEffort,
    runnerId,
    status,
    title,
    updatedAt,
    workingDirectory,
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
  const role = value["role"];
  const toolCallId = readNullableString(value["toolCallId"]);
  const toolName = readNullableString(value["toolName"]);

  if (
    typeof content !== "string" ||
    createdAt === undefined ||
    typeof id !== "string" ||
    (role !== "user" &&
      role !== "assistant" &&
      role !== "tool" &&
      role !== "thinking" &&
      role !== "system") ||
    toolCallId === undefined ||
    toolName === undefined
  ) {
    throw new Error("The server returned an invalid session message");
  }

  return {
    content,
    createdAt,
    id,
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
    autoCompact: detail.autoCompact,
    createdAt: detail.createdAt,
    credentialId: detail.credentialId,
    currentContextTokens: detail.currentContextTokens,
    id: detail.id,
    maxContextTokens: detail.maxContextTokens,
    model: detail.model,
    provider: detail.provider,
    reasoningEffort: detail.reasoningEffort,
    runnerId: detail.runnerId,
    status: detail.status,
    title: detail.title,
    updatedAt: detail.updatedAt,
    workingDirectory: detail.workingDirectory,
  };
}
