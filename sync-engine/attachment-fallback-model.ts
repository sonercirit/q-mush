import type { AgentAttachment } from "../shared/agent-attachments.ts";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
} from "../shared/agent-loop.ts";
import {
  prepareAttachmentFallbacks,
  type AttachmentFallbackConversion,
  type AttachmentFallbackSelection,
} from "./agent-attachment-fallback.ts";

interface AttachmentFallbackCall {
  readonly attachment: AgentAttachment;
  readonly selection: AttachmentFallbackSelection;
}

export class AttachmentFallbackAgentModel implements AgentModel {
  readonly #conversions = new Map<
    string,
    Promise<AttachmentFallbackConversion>
  >();
  readonly #convert: (
    call: AttachmentFallbackCall,
    signal?: AbortSignal,
  ) => Promise<AttachmentFallbackConversion>;
  readonly #currentModel: AgentModelOption;
  readonly #model: AgentModel;
  readonly #selections: readonly AttachmentFallbackSelection[];

  constructor(options: {
    readonly convert: (
      call: AttachmentFallbackCall,
      signal?: AbortSignal,
    ) => Promise<AttachmentFallbackConversion>;
    readonly currentModel: AgentModelOption;
    readonly model: AgentModel;
    readonly selections: readonly AttachmentFallbackSelection[];
  }) {
    this.#convert = options.convert;
    this.#currentModel = options.currentModel;
    this.#model = options.model;
    this.#selections = options.selections;
  }

  readonly startTurn = (): void => this.#model.startTurn?.();

  #conversion(
    attachment: AgentAttachment,
    selection: AttachmentFallbackSelection,
    signal?: AbortSignal,
  ): Promise<AttachmentFallbackConversion> {
    const key = `${selection.provider}\n${selection.credentialId}\n${selection.model}\n${selection.prompt ?? ""}\n${attachment.mediaType}\n${attachment.name}\n${attachment.data}`;
    const existing = this.#conversions.get(key);
    if (existing !== undefined) return existing;
    const conversion = this.#convert({ attachment, selection }, signal);
    this.#conversions.set(key, conversion);
    void conversion.catch(() => this.#conversions.delete(key));
    return conversion;
  }

  async complete(
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ) {
    return this.#model.complete(
      await prepareAttachmentFallbacks({
        convert: (attachment, selection) =>
          this.#conversion(attachment, selection, signal),
        currentModel: this.#currentModel,
        messages,
        selections: this.#selections,
      }),
      signal,
    );
  }
}
