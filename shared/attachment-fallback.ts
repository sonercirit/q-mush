import {
  AGENT_ATTACHMENT_MODALITIES,
  type AgentAttachmentModality,
} from "./agent-attachments.ts";
import { isAgentModelId } from "./agent-configuration.ts";
import { isRecord } from "./auth-model.ts";
import { isProviderId, type ProviderId } from "./provider-credential-store.ts";
import { readIdentifier } from "./validation.ts";

const MAXIMUM_ATTACHMENT_FALLBACK_PROMPT_LENGTH = 4_000;

export interface AttachmentFallbackSelection {
  readonly credentialId: string;
  readonly modality: AgentAttachmentModality;
  readonly model: string;
  readonly prompt: string | null;
  readonly provider: ProviderId;
}

function isAgentAttachmentModality(
  value: unknown,
): value is AgentAttachmentModality {
  return AGENT_ATTACHMENT_MODALITIES.some((modality) => modality === value);
}

export function readAttachmentFallbackSelection(
  value: unknown,
): AttachmentFallbackSelection | undefined {
  if (!isRecord(value)) return undefined;
  const credentialId = readIdentifier(value["credentialId"]);
  const modality = value["modality"];
  const model = value["model"];
  const promptValue = value["prompt"];
  const provider = value["provider"];
  const prompt = promptValue === undefined ? null : promptValue;
  return credentialId !== undefined &&
    isAgentAttachmentModality(modality) &&
    isAgentModelId(model) &&
    (prompt === null ||
      (typeof prompt === "string" &&
        prompt.length <= MAXIMUM_ATTACHMENT_FALLBACK_PROMPT_LENGTH)) &&
    isProviderId(provider)
    ? { credentialId, modality, model, prompt, provider }
    : undefined;
}

export function modelSupportsAttachmentModality(
  inputModalities: readonly string[] | null,
  modality: AgentAttachmentModality,
): boolean {
  return inputModalities === null
    ? modality === "image"
    : inputModalities.includes(modality) ||
        (modality === "pdf" && inputModalities.includes("file"));
}
