import {
  AGENT_ATTACHMENT_MODALITIES,
  type AgentAttachmentModality,
} from "./agent-attachments.ts";
import {
  isAgentModelId,
  readOpenRouterProviderTag,
} from "./agent-configuration.ts";
import { isRecord } from "./auth-model.ts";
import { isProviderId, type ProviderId } from "./provider-id.ts";
import { readIdentifier } from "./validation.ts";

export interface AttachmentFallbackSelection {
  readonly credentialId: string;
  readonly modality: AgentAttachmentModality;
  readonly model: string;
  readonly openRouterProviderTag: string | null;
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
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    !keys.every((key) =>
      [
        "credentialId",
        "modality",
        "model",
        "openRouterProviderTag",
        "provider",
      ].includes(key),
    )
  ) {
    return undefined;
  }
  const provider = value["provider"];
  const model = value["model"];
  const modality = value["modality"];
  const credentialId = readIdentifier(value["credentialId"]);
  const openRouterProviderTag = readOpenRouterProviderTag(
    value["openRouterProviderTag"],
  );
  return credentialId !== undefined &&
    isAgentAttachmentModality(modality) &&
    isAgentModelId(model) &&
    openRouterProviderTag !== undefined &&
    isProviderId(provider) &&
    (provider === "openrouter" || openRouterProviderTag === null)
    ? { credentialId, modality, model, openRouterProviderTag, provider }
    : undefined;
}

export function modelSupportsAttachmentModality(
  inputModalities: readonly string[] | null,
  modality: AgentAttachmentModality,
): boolean {
  return (
    inputModalities !== null &&
    (inputModalities.includes(modality) ||
      (modality === "pdf" && inputModalities.includes("file")))
  );
}
