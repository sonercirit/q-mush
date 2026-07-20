import { readAgentToolCalls } from "./agent-loop.ts";
import { isRecord, readNullableString } from "./auth-model.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionSummary,
} from "./session-model.ts";

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

  const createdAt = readFiniteNumber(value["createdAt"]);
  const credentialId = value["credentialId"];
  const id = value["id"];
  const model = value["model"];
  const provider = readProvider(value["provider"]);
  const runnerId = value["runnerId"];
  const status = readStatus(value["status"]);
  const title = value["title"];
  const updatedAt = readFiniteNumber(value["updatedAt"]);
  const workingDirectory = value["workingDirectory"];

  if (
    createdAt === undefined ||
    typeof credentialId !== "string" ||
    typeof id !== "string" ||
    typeof model !== "string" ||
    provider === undefined ||
    typeof runnerId !== "string" ||
    status === undefined ||
    typeof title !== "string" ||
    updatedAt === undefined ||
    typeof workingDirectory !== "string"
  ) {
    throw new Error("The server returned an invalid agent session");
  }

  return {
    createdAt,
    credentialId,
    id,
    model,
    provider,
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
    createdAt: detail.createdAt,
    credentialId: detail.credentialId,
    id: detail.id,
    model: detail.model,
    provider: detail.provider,
    runnerId: detail.runnerId,
    status: detail.status,
    title: detail.title,
    updatedAt: detail.updatedAt,
    workingDirectory: detail.workingDirectory,
  };
}
