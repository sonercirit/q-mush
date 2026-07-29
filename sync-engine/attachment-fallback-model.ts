import {
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import { modelSupportsAttachmentModality } from "../shared/attachment-fallback.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import {
  createFallbackModel,
  type AgentModelFactory,
} from "./session-agent-models.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";

export async function explainAttachment(
  options: {
    readonly attachment: AgentAttachment;
    readonly currentCredential: ProviderCredentialAccess;
    readonly currentModel: AgentModelOption;
    readonly currentModelId: string;
    readonly currentProvider: "openai" | "openrouter";
    readonly currentProviderTag: string | null;
    readonly factory: AgentModelFactory;
    readonly prompt: string | null;
    readonly resources: AttachmentFallbackRuntimeResources;
    readonly userId: string;
    readonly workspaceId: string;
  },
  signal?: AbortSignal,
): Promise<string> {
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
  if (selection !== undefined) {
    const catalog = await options.resources.discoverModels?.(
      selection.provider,
      credential,
    );
    if (!catalog?.models.some(({ id }) => id === selection.model)) {
      throw new Error(`The global ${modality} fallback model is unavailable`);
    }
  }
  const model = createFallbackModel(options.factory, {
    credential,
    model: selection?.model ?? options.currentModelId,
    openRouterProviderTag:
      selection?.openRouterProviderTag ?? options.currentProviderTag,
    prompt: options.prompt,
    provider: selection?.provider ?? options.currentProvider,
  });
  const turn = await model.complete(
    [{ attachments: [options.attachment], content: "", role: "user" }],
    signal,
  );
  return turn.content;
}
