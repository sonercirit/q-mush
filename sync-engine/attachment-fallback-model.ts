import {
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import {
  TRUNCATION_NOTICES,
  type AgentModelStep,
} from "../shared/agent-loop.ts";
import { modelSupportsAttachmentModality } from "../shared/attachment-fallback.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { AgentModelRequestOptions } from "./agent-model-options.ts";
import {
  createFallbackModel,
  type AgentModelFactory,
} from "./session-agent-models.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";

export interface AttachmentExplanation {
  readonly content: string;
  readonly model: string;
  readonly provider: ProviderId;
  readonly providerPricing: ProviderModelPricing | null;
  readonly usage: Pick<AgentModelStep, "costUsd" | "tokenUsage">;
}

function throwIfAttachmentRestartRequested(
  restartRequested: (() => boolean) | undefined,
): void {
  if (restartRequested?.() === true) {
    throw new DOMException(
      "The restart began before the attachment explanation model request",
      "RestartHandoff",
    );
  }
}

export async function explainAttachment(
  options: {
    readonly attachment: AgentAttachment;
    readonly currentCredential: ProviderCredentialAccess;
    readonly currentModel: AgentModelOption;
    readonly currentModelId: string;
    readonly currentProvider: ProviderId;
    readonly currentProviderPricing: ProviderModelPricing | null;
    readonly currentProviderTag: string | null;
    readonly factory: AgentModelFactory;
    readonly onRequestState?: AgentModelRequestOptions["onRequestState"];
    readonly onStepStart?: () => void;
    readonly restartRequested?: () => boolean;
    readonly prompt: string | null;
    readonly resources: AttachmentFallbackRuntimeResources;
    readonly toolSettings: ToolSettings;
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
      `The session model does not report ${modality} support. Configure a global ${modality} fallback with reported support in Attachment fallback settings.`,
    );
  }
  const credential =
    selection === undefined
      ? options.currentCredential
      : await options.resources.readCredential?.(options.userId, {
          ...selection,
          workspaceId: options.workspaceId,
        });
  throwIfAttachmentRestartRequested(options.restartRequested);
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
      signal,
    );
    throwIfAttachmentRestartRequested(options.restartRequested);
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
  throwIfAttachmentRestartRequested(options.restartRequested);
  const model = createFallbackModel(options.factory, {
    adaptiveThinking: selectedModel.adaptiveThinking,
    credential,
    maxOutputTokens: selectedModel.maxOutputTokens,
    model: selectedModelId,
    onRequestState: options.onRequestState,
    openRouterProviderTag:
      selection?.openRouterProviderTag ?? options.currentProviderTag,
    prompt: options.prompt,
    provider: selectedProvider,
    providerPricing: selectedPricing,
    toolSettings: options.toolSettings,
  });
  let step;
  try {
    // The explanation is its own model request: restart the visible step
    // clock so a slow fallback does not extend the preceding agent step.
    throwIfAttachmentRestartRequested(options.restartRequested);
    options.onStepStart?.();
    step = await model.complete(
      [{ attachments: [options.attachment], content: "", role: "user" }],
      signal,
    );
  } finally {
    model.close?.();
  }
  return {
    // Surface a length stop in the tool result itself so the agent never
    // relies on an incomplete explanation as if it were finished.
    content:
      step.truncation === undefined
        ? step.content
        : `${step.content}\n\n${TRUNCATION_NOTICES[step.truncation]}`,
    model: selectedModelId,
    provider: selectedProvider,
    providerPricing: selectedPricing,
    usage: { costUsd: step.costUsd, tokenUsage: step.tokenUsage },
  };
}
