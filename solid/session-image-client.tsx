import { For, Show, type JSX } from "solid-js";
import {
  agentAttachmentDataUrl,
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import { AGENT_IMAGE_ACCEPT } from "./session-image-input.ts";

function AttachmentPreview(props: {
  readonly attachment: AgentAttachment;
}): JSX.Element {
  return (
    <Show
      fallback={
        <div class="grid h-20 place-items-center rounded-lg bg-slate-900 px-2 text-center text-xs font-medium text-slate-300">
          {agentAttachmentModality(props.attachment).toUpperCase()}
        </div>
      }
      when={agentAttachmentModality(props.attachment) === "image"}
    >
      <img
        alt={props.attachment.name}
        class="h-20 w-full rounded-lg object-cover"
        src={agentAttachmentDataUrl(props.attachment)}
      />
    </Show>
  );
}

interface SessionImageInputProps {
  readonly disabled: boolean;
  readonly id: string;
  readonly images: readonly AgentAttachment[];
  readonly onAdd: (files: readonly File[]) => void;
  readonly onRemove: (index: number) => void;
}

export function SessionImagePreviews(props: {
  readonly disabled?: boolean;
  readonly images: readonly AgentAttachment[];
  readonly onRemove?: (index: number) => void;
}): JSX.Element {
  return (
    <Show when={props.images.length > 0}>
      <ul class="flex flex-wrap gap-3" data-session-attachments="true">
        <For each={props.images}>
          {(image, index) => (
            <li class="relative min-w-0 w-24 rounded-xl border border-white/10 bg-slate-950/80 p-2 sm:w-28">
              <AttachmentPreview attachment={image} />
              <p class="path-wrap mt-1 text-xs text-slate-400">{image.name}</p>
              <Show when={props.onRemove} keyed>
                {(onRemove) => (
                  <button
                    aria-label={`Remove ${image.name}`}
                    class="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-white/10 bg-slate-900 text-xs text-slate-300 hover:text-rose-200 disabled:opacity-50"
                    data-image-index={index()}
                    disabled={props.disabled ?? false}
                    onClick={() => {
                      onRemove(index());
                    }}
                    type="button"
                  >
                    ×
                  </button>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

export function SessionImageInput(props: SessionImageInputProps): JSX.Element {
  return (
    <div class="space-y-3">
      <SessionImagePreviews
        disabled={props.disabled}
        images={props.images}
        onRemove={props.onRemove}
      />
      <label class="inline-flex cursor-pointer items-center rounded-xl border border-white/10 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        Attach files
        <input
          accept={AGENT_IMAGE_ACCEPT}
          class="sr-only"
          disabled={props.disabled}
          id={props.id}
          multiple
          onChange={(event) => {
            const input = event.currentTarget;
            const files = input.files === null ? [] : [...input.files];
            input.value = "";
            if (files.length > 0) {
              props.onAdd(files);
            }
          }}
          type="file"
        />
      </label>
      <p class="text-xs text-slate-500">
        Select or paste supported image, video, audio, PDF, document, archive,
        text, or generic files. Up to 8 attachments, 10 MB each.
      </p>
    </div>
  );
}
