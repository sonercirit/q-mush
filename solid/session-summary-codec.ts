import {
  isAgentReasoningEffort,
  isOpenRouterProviderSelection,
} from "../shared/agent-configuration.ts";
import { readAgentSessionToolNames } from "../shared/agent-tools.ts";
import { readPendingAskQuestions } from "../shared/ask-questions.ts";
import { isRecord, readNullableString } from "../shared/auth-model.ts";
import { isProviderId } from "../shared/provider-id.ts";
import { readProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  isNullOrPositiveSafeInteger,
  readFiniteNumber,
} from "../shared/validation.ts";

const STATUS_READERS: Readonly<
  Record<AgentSessionStatus, () => AgentSessionStatus>
> = {
  completed: () => "completed",
  failed: () => "failed",
  idle: () => "idle",
  paused: () => "paused",
  queued: () => "queued",
  running: () => "running",
  stopped: () => "stopped",
};

function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "idle" ||
    value === "paused" ||
    value === "queued" ||
    value === "running" ||
    value === "stopped"
  );
}

function readStatus(value: unknown): AgentSessionStatus | undefined {
  return isAgentSessionStatus(value) ? STATUS_READERS[value]() : undefined;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

const RESTART_HANDOFF_KEYS = [
  "executionGeneration",
  "operation",
  "pendingInput",
  "requestedBy",
  "restartId",
] as const;

function readRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null | undefined {
  return value === null ? null : isRecord(value) ? value : undefined;
}

function readRestartHandoff(
  value: unknown,
): AgentSessionSummary["restartHandoff"] | undefined {
  const record = readRecord(value);
  if (record === null) return null;
  if (record === undefined) return undefined;
  const executionGeneration = readFiniteNumber(record["executionGeneration"]);
  const operation = record["operation"];
  const pendingInput = record["pendingInput"];
  const requestedBy = record["requestedBy"];
  const restartId = record["restartId"];
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
    exactObjectKeys(record, RESTART_HANDOFF_KEYS)
    ? {
        executionGeneration,
        operation,
        pendingInput: [],
        requestedBy,
        restartId,
      }
    : undefined;
}

type RuntimePendingComponent = NonNullable<
  AgentSessionSummary["runtimePending"]
>["component"];

const RUNTIME_PENDING_COMPONENTS: Readonly<
  Record<RuntimePendingComponent, true>
> = {
  engine_tool: true,
  provider_admission: true,
  provider_request: true,
  runner_command: true,
  startup: true,
};

function isRuntimePendingComponent(
  value: unknown,
): value is RuntimePendingComponent {
  return (
    (value === "engine_tool" ||
      value === "provider_admission" ||
      value === "provider_request" ||
      value === "runner_command" ||
      value === "startup") &&
    RUNTIME_PENDING_COMPONENTS[value]
  );
}

function readRuntimePending(
  value: unknown,
): AgentSessionSummary["runtimePending"] | undefined {
  const record = readRecord(value);
  if (record === undefined) return undefined;
  if (record === null) return null;
  const component = record["component"];
  const since = readFiniteNumber(record["since"]);
  return isRuntimePendingComponent(component) &&
    since !== undefined &&
    Number.isSafeInteger(since) &&
    since >= 0 &&
    exactObjectKeys(record, ["component", "since"])
    ? { component, since }
    : undefined;
}

function invalidSession(): never {
  throw new Error("The server returned an invalid agent session");
}

export function readSessionSummary(value: unknown): AgentSessionSummary {
  if (!isRecord(value)) invalidSession();
  const number = (key: string) => readFiniteNumber(value[key]);
  const activeDurationMs = number("activeDurationMs");
  const activeStartedAt =
    value["activeStartedAt"] === null ? null : number("activeStartedAt");
  const stepStartedAt =
    value["stepStartedAt"] === null ? null : number("stepStartedAt");
  const agentFilePath = readNullableString(value["agentFilePath"]);
  const providerPricing = readProviderModelPricing(value["providerPricing"]);
  const adaptiveThinking = value["adaptiveThinking"];
  const autoCompact = value["autoCompact"];
  const idleCompact = value["idleCompact"];
  const costBasis = value["costBasis"];
  const costUsd = number("costUsd");
  const createdAt = number("createdAt");
  const credentialId = value["credentialId"];
  const currentContextTokens = number("currentContextTokens");
  const executionEnvironment = value["executionEnvironment"];
  const generation = number("generation");
  const hasOlderSegments = value["hasOlderSegments"];
  const id = value["id"];
  const maxContextTokens = value["maxContextTokens"];
  const maxOutputTokens = value["maxOutputTokens"];
  const userContextTokenCap = value["userContextTokenCap"];
  const model = value["model"];
  const pendingQuestions =
    value["pendingQuestions"] === undefined ||
    value["pendingQuestions"] === null
      ? null
      : readPendingAskQuestions(value["pendingQuestions"]);
  const provider = isProviderId(value["provider"])
    ? value["provider"]
    : undefined;
  const openRouterProviderTag =
    provider === "openrouter"
      ? readNullableString(value["openRouterProviderTag"])
      : value["openRouterProviderTag"] === null
        ? null
        : undefined;
  const parentExecutionGeneration =
    value["parentExecutionGeneration"] === null
      ? null
      : number("parentExecutionGeneration");
  const parentSessionId = readNullableString(value["parentSessionId"]);
  const reasoningEffort = readNullableString(value["reasoningEffort"]);
  const restartHandoff = readRestartHandoff(value["restartHandoff"]);
  const runtimePending = readRuntimePending(value["runtimePending"]);
  const runnerId = value["runnerId"];
  const runnerRequired = value["runnerRequired"];
  const status = readStatus(value["status"]);
  const title = value["title"];
  const tools = readAgentSessionToolNames(value["tools"]);
  const updatedAt = number("updatedAt");
  const workingDirectory = value["workingDirectory"];
  const workspaceId = value["workspaceId"];

  if (
    activeDurationMs === undefined ||
    activeDurationMs < 0 ||
    !Number.isSafeInteger(activeDurationMs) ||
    activeStartedAt === undefined ||
    (activeStartedAt !== null && !Number.isSafeInteger(activeStartedAt)) ||
    stepStartedAt === undefined ||
    (stepStartedAt !== null && !Number.isSafeInteger(stepStartedAt)) ||
    agentFilePath === undefined ||
    providerPricing === undefined ||
    (adaptiveThinking !== null && typeof adaptiveThinking !== "boolean") ||
    typeof autoCompact !== "boolean" ||
    typeof idleCompact !== "boolean" ||
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
    !isNullOrPositiveSafeInteger(maxContextTokens) ||
    !isNullOrPositiveSafeInteger(maxOutputTokens) ||
    !isNullOrPositiveSafeInteger(userContextTokenCap) ||
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
    reasoningEffort === undefined ||
    (reasoningEffort !== null && !isAgentReasoningEffort(reasoningEffort)) ||
    restartHandoff === undefined ||
    runtimePending === undefined ||
    (runtimePending !== null && status !== "running") ||
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
    invalidSession();
  }

  return {
    activeDurationMs,
    activeStartedAt,
    adaptiveThinking,
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
    idleCompact,
    maxContextTokens,
    maxOutputTokens,
    model,
    openRouterProviderTag,
    parentExecutionGeneration,
    parentSessionId,
    pendingQuestions,
    provider,
    providerPricing,
    reasoningEffort,
    restartHandoff,
    runtimePending,
    runnerId,
    runnerRequired,
    status,
    stepStartedAt,
    title,
    tools,
    updatedAt,
    userContextTokenCap,
    workingDirectory,
    workspaceId,
  };
}

function summaryFields(detail: AgentSessionDetail): AgentSessionSummary {
  return {
    activeDurationMs: detail.activeDurationMs,
    activeStartedAt: detail.activeStartedAt,
    adaptiveThinking: detail.adaptiveThinking,
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
    idleCompact: detail.idleCompact,
    maxContextTokens: detail.maxContextTokens,
    maxOutputTokens: detail.maxOutputTokens,
    model: detail.model,
    openRouterProviderTag: detail.openRouterProviderTag,
    parentExecutionGeneration: detail.parentExecutionGeneration,
    parentSessionId: detail.parentSessionId,
    pendingQuestions: detail.pendingQuestions,
    provider: detail.provider,
    providerPricing: detail.providerPricing,
    reasoningEffort: detail.reasoningEffort,
    restartHandoff: detail.restartHandoff,
    runtimePending: detail.runtimePending,
    runnerId: detail.runnerId,
    runnerRequired: detail.runnerRequired,
    status: detail.status,
    stepStartedAt: detail.stepStartedAt,
    title: detail.title,
    tools: detail.tools,
    updatedAt: detail.updatedAt,
    userContextTokenCap: detail.userContextTokenCap,
    workingDirectory: detail.workingDirectory,
    workspaceId: detail.workspaceId,
  };
}

export function summaryFromDetail(
  detail: AgentSessionDetail,
): AgentSessionSummary {
  return summaryFields(detail);
}
