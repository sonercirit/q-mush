import type { AgentAttachment } from "../shared/agent-attachments.ts";
import { ATTACHMENT_WRITE_COMMAND } from "../shared/attachment-reference.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { attachmentFallbackReference } from "./agent-attachment-fallback.ts";

export async function storeSessionAttachment(options: {
  readonly attachment: AgentAttachment;
  readonly broker: RunnerCommandBroker;
  readonly description: string;
  readonly session: AgentSessionDetail;
  readonly signal: AbortSignal;
}): Promise<string> {
  const id = createUuidV7();
  await options.broker.dispatch(
    {
      arguments: {
        description: options.description,
        id,
        mediaType: options.attachment.mediaType,
        name: options.attachment.name,
      },
      authorize: () => !options.signal.aborted,
      executionEnvironment: "bare_metal",
      generation: options.session.generation,
      runnerId: options.session.runnerId,
      sessionId: options.session.id,
      tool: ATTACHMENT_WRITE_COMMAND,
      workingDirectory: options.session.workingDirectory,
    },
    options.signal,
  );
  const modality = options.attachment.mediaType.startsWith("image/")
    ? "image"
    : options.attachment.mediaType.startsWith("video/")
      ? "video"
      : options.attachment.mediaType.startsWith("audio/")
        ? "audio"
        : options.attachment.mediaType === "application/pdf"
          ? "pdf"
          : "file";
  return attachmentFallbackReference(modality, options.attachment.name, id);
}
