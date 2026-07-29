import {
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import type { AgentModelTurn } from "../shared/agent-loop.ts";
import { modelSupportsAttachmentModality } from "../shared/attachment-fallback.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import {
  createFallbackModel,
  type AgentModelFactory,
} from "./session-agent-models.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";

export interface AttachmentExplanation {
  readonly content: string;
  readonly model: string;
  readonly provider: "openai" | "openrouter";
  readonly providerPricing: ProviderModelPricing | null;
  readonly usage: Pick<AgentModelTurn, "costUsd" | "tokenUsage">;
}

export async function explainAttachment(
  options: {
    readonly attachment: AgentAttachment;
    readonly currentCredential: ProviderCredentialAccess;
    readonly currentModel: AgentModelOption;
    readonly currentModelId: string;
    readonly currentProvider: "openai" | "openrouter";
    readonly currentProviderPricing: ProviderModelPricing | null;
    readonly currentProviderTag: string | null;
    readonly factory: AgentModelFactory;
    readonly prompt: string | null;
    readonly resources: AttachmentFallbackRuntimeResources;
    readonly userId: string;
    readonly workspaceId: string;
  },
  signal?: AbortSignal,
): Promise<AttachmentExplanation> {
  const modality = agentAttachmentModality(options.attachment);
  const native = modelSupportsAttachmentModality(
    options.currentModel.inputModalities,
    modality,
  );
  const selection = native
    ? undefined
    : options.resources
        .attachmentFallbacks?.()
        .find((candidate) => candidate.modality === modality);
  if (!native && selection === undefined) {
    throw new Error(
      `The session model cannot read ${modality} files. Configure the global ${modality} fallback in Attachment fallback settings.`,
    );
  }
  const credential =
    selection === undefined
      ? options.currentCredential
      : await options.resources.readCredential?.(options.userId, {
          ...selection,
          workspaceId: options.workspaceId,
        });
  if (credential === undefined) {
    throw new Error(
      `The global ${modality} fallback credential is unavailable`,
    );
  }
  let selectedModel = options.currentModel;
  if (selection !== undefined) {
    const catalog = await options.resources.discoverModels?.(
      selection.provider,
      credential,
    );
    const fallbackModel = catalog?.models.find(
      ({ id }) => id === selection.model,
    );
    if (fallbackModel === undefined) {
      throw new Error(`The global ${modality} fallback model is unavailable`);
    }
    selectedModel = fallbackModel;
  }
  const selectedModelId = selection?.model ?? options.currentModelId;
  const selectedProvider = selection?.provider ?? options.currentProvider;
  const selectedPricing =
    selection === undefined
      ? options.currentProviderPricing
      : selectedModel.pricing;
  const model = createFallbackModel(options.factory, {
    credential,
    model: selectedModelId,
    openRouterProviderTag:
      selection?.openRouterProviderTag ?? options.currentProviderTag,
    prompt: options.prompt,
    provider: selectedProvider,
    providerPricing: selectedPricing,
  });
  const turn = await model.complete(
    [{ attachments: [options.attachment], content: "", role: "user" }],
    signal,
  );
  return {
    content: turn.content,
    model: selectedModelId,
    provider: selectedProvider,
    providerPricing: selectedPricing,
    usage: { costUsd: turn.costUsd, tokenUsage: turn.tokenUsage },
  };
}
