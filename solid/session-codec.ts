import {
  isAgentModelId,
  isAgentReasoningEffort,
  isOpenRouterProviderSelection,
  isOpenRouterProviderTag,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentReasoningEffort,
  type OpenRouterProviderCatalog,
} from "../shared/agent-configuration.ts";
import { readAgentFile } from "../shared/agent-file.ts";
import { readAgentToolCalls } from "../shared/agent-loop.ts";
import { readAgentSessionToolNames } from "../shared/agent-tools.ts";
import {
  readPendingAskQuestions,
  type PendingAskQuestions,
} from "../shared/ask-questions.ts";
import { isRecord, readNullableString } from "../shared/auth-model.ts";
import { isProviderId } from "../shared/provider-id.ts";
import {
  readProviderModelPricing,
  type ProviderModelPricing,
} from "../shared/provider-model-pricing.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionSummary,
  AgentSessionTurn,
} from "../shared/session-model.ts";
import {
  readFiniteNumber,
  readNonNegativeSafeInteger,
  stringArray,
} from "../shared/validation.ts";
import { readSessionContentFields } from "./session-message-codec.ts";
import { decodedSessionMessage } from "./session-message-decoder.ts";

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
  const fallbackPromptValue = value["fallbackPrompt"];
  const id = value["id"];
  const inputModalitiesValue = value["inputModalities"];
  const label = value["label"];
  const outputModalitiesValue = value["outputModalities"];
  const pricingValue = value["pricing"];

  if (
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

  return {
    contextWindow,
    fallbackPrompt:
      typeof fallbackPromptValue === "string" ? fallbackPromptValue : null,
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

function readStatus(value: unknown): AgentSessionStatus | undefined {
  switch (value) {
    case "completed":
    case "failed":
    case "idle":
    case "paused":
    case "queued":
    case "running":
    case "stopped":
      return value;
    default:
      return undefined;
  }
}

const RESTART_HANDOFF_KEYS = new Set([
  "executionGeneration",
  "operation",
  "pendingInput",
  "requestedBy",
  "restartId",
]);

function hasRestartHandoffShape(
  value: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === RESTART_HANDOFF_KEYS.size &&
    keys.every((key) => RESTART_HANDOFF_KEYS.has(key))
  );
}

function readRestartHandoff(
  value: unknown,
): AgentSessionSummary["restartHandoff"] | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const executionGeneration = readFiniteNumber(value["executionGeneration"]);
  const operation = value["operation"];
  const pendingInput = value["pendingInput"];
  const requestedBy = value["requestedBy"];
  const restartId = value["restartId"];
  return executionGeneration !== undefined &&
    executionGeneration >= 0 &&
    Number.isSafeInteger(executionGeneration) &&
    (operation === "agent" ||
      operation === "compact" ||
      operation === "compact_and_continue") &&
    Array.isArray(pendingInput) &&
    pendingInput.length === 0 &&
    (requestedBy === "runner" || requestedBy === "server") &&
    typeof restartId === "string" &&
    restartId.length > 0 &&
    restartId.length <= 200 &&
    hasRestartHandoffShape(value)
    ? {
        executionGeneration,
        operation,
        pendingInput: [],
        requestedBy,
        restartId,
      }
    : undefined;
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
  const agentFilePath = readNullableString(value["agentFilePath"]);
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
  const executionEnvironment = value["executionEnvironment"];
  const generation = readFiniteNumber(value["generation"]);
  const hasOlderSegments = value["hasOlderSegments"];
  const id = value["id"];
  const maxContextTokens = value["maxContextTokens"];
  const model = value["model"];
  const pendingQuestions =
    value["pendingQuestions"] === undefined ||
    value["pendingQuestions"] === null
      ? null
      : readPendingAskQuestions(value["pendingQuestions"]);
  const providerValue = value["provider"];
  const provider = isProviderId(providerValue) ? providerValue : undefined;
  const openRouterProviderTagValue = value["openRouterProviderTag"];
  const openRouterProviderTag =
    provider === "openrouter"
      ? readNullableString(openRouterProviderTagValue)
      : openRouterProviderTagValue === null
        ? null
        : undefined;
  const parentExecutionGenerationValue = value["parentExecutionGeneration"];
  const parentExecutionGeneration =
    parentExecutionGenerationValue === null
      ? null
      : readFiniteNumber(parentExecutionGenerationValue);
  const parentSessionId = readNullableString(value["parentSessionId"]);
  const reasoningEffort = readNullableString(value["reasoningEffort"]);
  const restartHandoff = readRestartHandoff(value["restartHandoff"]);
  const runnerId = value["runnerId"];
  const runnerRequired = value["runnerRequired"];
  const status = readStatus(value["status"]);
  const title = value["title"];
  const tools = readAgentSessionToolNames(value["tools"]);
  const updatedAt = readFiniteNumber(value["updatedAt"]);
  const workingDirectory = value["workingDirectory"];
  const workspaceId = value["workspaceId"];

  if (
    activeDurationMs === undefined ||
    activeDurationMs < 0 ||
    !Number.isSafeInteger(activeDurationMs) ||
    activeStartedAt === undefined ||
    agentFilePath === undefined ||
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
    (executionEnvironment !== "bare_metal" &&
      executionEnvironment !== "container") ||
    generation === undefined ||
    generation < 0 ||
    !Number.isSafeInteger(generation) ||
    typeof hasOlderSegments !== "boolean" ||
    typeof id !== "string" ||
    (maxContextTokens !== null &&
      (typeof maxContextTokens !== "number" ||
        !Number.isSafeInteger(maxContextTokens) ||
        maxContextTokens <= 0)) ||
    typeof model !== "string" ||
    pendingQuestions === undefined ||
    (pendingQuestions !== null &&
      pendingQuestions.executionGeneration !== generation) ||
    provider === undefined ||
    openRouterProviderTag === undefined ||
    (openRouterProviderTag !== null &&
      !isOpenRouterProviderSelection(openRouterProviderTag)) ||
    parentExecutionGeneration === undefined ||
    (parentExecutionGeneration !== null &&
      (!Number.isSafeInteger(parentExecutionGeneration) ||
        parentExecutionGeneration < 0)) ||
    parentSessionId === undefined ||
    (parentExecutionGeneration !== null && parentSessionId === null) ||
    value["providerPricing"] === undefined ||
    reasoningEffort === undefined ||
    (reasoningEffort !== null && !isAgentReasoningEffort(reasoningEffort)) ||
    restartHandoff === undefined ||
    (restartHandoff !== null &&
      restartHandoff.executionGeneration !== generation) ||
    (status === "paused" &&
      (restartHandoff === null) === (pendingQuestions === null)) ||
    (pendingQuestions !== null && status !== "paused") ||
    (restartHandoff !== null && pendingQuestions !== null) ||
    (restartHandoff !== null &&
      status !== "paused" &&
      status !== "queued" &&
      status !== "running") ||
    typeof runnerId !== "string" ||
    typeof runnerRequired !== "boolean" ||
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
    agentFilePath,
    autoCompact,
    costBasis,
    costUsd,
    createdAt,
    credentialId,
    currentContextTokens,
    executionEnvironment,
    generation,
    hasOlderSegments,
    id,
    maxContextTokens,
    model,
    openRouterProviderTag,
    parentExecutionGeneration,
    parentSessionId,
    provider,
    providerPricing,
    pendingQuestions,
    reasoningEffort,
    restartHandoff,
    runnerId,
    runnerRequired,
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
  if (
    boundaryMessageId === undefined ||
    endedAt === undefined ||
    executionGeneration === undefined ||
    typeof value["id"] !== "string" ||
    startedAt === undefined ||
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

  return {
    ...readSummary(value),
    agentFile: readAgentFile(value["agentFile"]),
    messages: value["messages"].map(readMessage),
    pendingInputs: value["pendingInputs"].map(readSessionPendingInput),
    ...(Array.isArray(value["turns"])
      ? { turns: value["turns"].map(readTurn) }
      : {}),
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
    agentFilePath: detail.agentFilePath,
    autoCompact: detail.autoCompact,
    costBasis: detail.costBasis,
    costUsd: detail.costUsd,
    createdAt: detail.createdAt,
    credentialId: detail.credentialId,
    currentContextTokens: detail.currentContextTokens,
    executionEnvironment: detail.executionEnvironment,
    generation: detail.generation,
    hasOlderSegments: detail.hasOlderSegments,
    id: detail.id,
    maxContextTokens: detail.maxContextTokens,
    model: detail.model,
    openRouterProviderTag: detail.openRouterProviderTag,
    parentExecutionGeneration: detail.parentExecutionGeneration,
    parentSessionId: detail.parentSessionId,
    provider: detail.provider,
    providerPricing: detail.providerPricing,
    pendingQuestions: detail.pendingQuestions,
    reasoningEffort: detail.reasoningEffort,
    restartHandoff: detail.restartHandoff,
    runnerId: detail.runnerId,
    runnerRequired: detail.runnerRequired,
    status: detail.status,
    title: detail.title,
    tools: detail.tools,
    updatedAt: detail.updatedAt,
    workingDirectory: detail.workingDirectory,
    workspaceId: detail.workspaceId,
  };
}
