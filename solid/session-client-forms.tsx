import { type JSX } from "solid-js";
import type { AgentImage } from "../shared/agent-images.ts";
import { SessionImageInput } from "./session-image-client.tsx";
import { readPastedAgentImageFiles } from "./session-image-input.ts";

interface SessionImagesProps {
  readonly images: readonly AgentImage[];
  readonly onAddImages: (files: readonly File[]) => void;
  readonly onRemoveImage: (index: number) => void;
}

interface PromptEventProps {
  readonly onAddImages: SessionImagesProps["onAddImages"];
  readonly onInput: (value: string) => void;
}

interface SessionPromptInputProps extends PromptEventProps, SessionImagesProps {
  readonly disabled: boolean;
  readonly prompt: string;
}

interface SessionFollowUpProps extends PromptEventProps, SessionImagesProps {
  readonly onKeyDown: (
    event: KeyboardEvent & { readonly currentTarget: HTMLTextAreaElement },
  ) => void;
  readonly onSubmit: () => void;
  readonly prompt: string;
  readonly sending: boolean;
}

function promptEvents(props: PromptEventProps) {
  return {
    onInput: (event: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
      props.onInput(event.currentTarget.value);
    },
    onPaste: (event: ClipboardEvent) => {
      const files = readPastedAgentImageFiles(event);
      if (files.length > 0) {
        props.onAddImages(files);
      }
    },
  };
}

function renderSessionImages(
  props: SessionImagesProps & {
    readonly disabled: boolean;
    readonly id: string;
  },
): JSX.Element {
  return (
    <SessionImageInput
      disabled={props.disabled}
      id={props.id}
      images={props.images}
      onAdd={props.onAddImages}
      onRemove={props.onRemoveImage}
    />
  );
}

export function SessionPromptInput(
  props: SessionPromptInputProps,
): JSX.Element {
  return (
    <div class="lg:col-span-2">
      <label class="text-sm font-medium text-slate-200" for="session-prompt">
        Task
      </label>
      <textarea
        class="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm leading-6 text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        disabled={props.disabled}
        id="session-prompt"
        name="prompt"
        placeholder="Describe the change you want the agent to make…"
        value={props.prompt}
        {...promptEvents(props)}
      />
      <div class="mt-3">
        {renderSessionImages({
          ...props,
          id: "session-images",
        })}
      </div>
    </div>
  );
}

export function SessionFollowUp(props: SessionFollowUpProps): JSX.Element {
  return (
    <form
      class="flex min-w-0 flex-1 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <textarea
        class="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        disabled={props.sending}
        name="prompt"
        onKeyDown={props.onKeyDown}
        placeholder="Give this session another instruction…"
        value={props.prompt}
        {...promptEvents(props)}
      />
      {renderSessionImages({
        disabled: props.sending,
        id: "follow-up-images",
        ...props,
      })}
      <button
        class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
        disabled={props.sending}
        type="submit"
      >
        {props.sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
