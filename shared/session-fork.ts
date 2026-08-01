import {
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentReasoningEffort,
} from "./agent-configuration.ts";
import { isRecord } from "./auth-model.ts";
import { isProviderId, type ProviderId } from "./provider-id.ts";
import { readIdentifier } from "./validation.ts";

export interface SessionForkSelection {
  readonly credentialId: string;
  readonly model: string;
  readonly provider: ProviderId;
  readonly reasoningEffort?: AgentReasoningEffort | null;
}

export interface SessionForkInput {
  readonly credentialId?: string;
  readonly forkPointMessageId: string;
  readonly model?: string;
  readonly provider?: ProviderId;
  readonly reasoningEffort?: AgentReasoningEffort | null;
  readonly sourceSessionId: string;
  readonly workspaceId: string;
}

const SESSION_FORK_KEYS = new Set([
  "credentialId",
  "forkPointMessageId",
  "model",
  "provider",
  "reasoningEffort",
  "sourceSessionId",
  "workspaceId",
]);

export function sessionForkSelection(
  input: SessionForkInput,
): SessionForkSelection | undefined {
  const { credentialId, model, provider, reasoningEffort } = input;
  return credentialId === undefined ||
    model === undefined ||
    provider === undefined
    ? undefined
    : {
        credentialId,
        model,
        provider,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
}

function readForkSelection(
  record: Readonly<Record<string, unknown>>,
): SessionForkSelection | undefined {
  const credentialId = readIdentifier(record["credentialId"]);
  const model = record["model"];
  const provider = record["provider"];
  const reasoningEffort = record["reasoningEffort"];
  const hasReasoningEffort = "reasoningEffort" in record;
  const selectedReasoningEffort =
    reasoningEffort === null || isAgentReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : undefined;
  if (
    credentialId === undefined ||
    !isAgentModelId(model) ||
    !isProviderId(provider) ||
    (hasReasoningEffort && selectedReasoningEffort === undefined)
  ) {
    return undefined;
  }
  if (hasReasoningEffort) {
    return {
      credentialId,
      model,
      provider,
      reasoningEffort: selectedReasoningEffort ?? null,
    };
  }
  return { credentialId, model, provider };
}

export function readSessionForkInput(
  value: unknown,
): SessionForkInput | undefined {
  const record = isRecord(value) ? value : undefined;
  if (
    record === undefined ||
    !Object.keys(record).every((key) => SESSION_FORK_KEYS.has(key))
  ) {
    return undefined;
  }
  const forkPointMessageId = readIdentifier(record["forkPointMessageId"]);
  const sourceSessionId = readIdentifier(record["sourceSessionId"]);
  const workspaceId = readIdentifier(record["workspaceId"]);
  const hasSelection =
    "credentialId" in record || "model" in record || "provider" in record;
  const selection = hasSelection ? readForkSelection(record) : undefined;
  if (
    forkPointMessageId === undefined ||
    sourceSessionId === undefined ||
    workspaceId === undefined ||
    (!hasSelection && "reasoningEffort" in record) ||
    (hasSelection && selection === undefined)
  ) {
    return undefined;
  }
  if (selection === undefined) {
    return { forkPointMessageId, sourceSessionId, workspaceId };
  }
  return {
    ...selection,
    forkPointMessageId,
    sourceSessionId,
    workspaceId,
  };
}
