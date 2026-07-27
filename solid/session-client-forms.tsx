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
  readonly availabilityDescriptionId: string;
  readonly availabilityLabel: string;
  readonly disabled: boolean;
  readonly onKeyDown: (
    event: KeyboardEvent & { readonly currentTarget: HTMLTextAreaElement },
  ) => void;
  readonly onSubmit: () => void;
  readonly prompt: string;
  readonly sending: boolean;
  readonly submitLabel?: string;
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
    <div class="md:col-span-2">
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
      aria-label="Send another instruction"
      class="flex min-w-0 flex-1 flex-col gap-3"
      data-session-composer="true"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.disabled) {
          props.onSubmit();
        }
      }}
    >
      <textarea
        aria-describedby={props.availabilityDescriptionId}
        aria-disabled={props.disabled}
        aria-label="Follow-up instruction"
        class="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        name="prompt"
        onKeyDown={props.onKeyDown}
        placeholder="Give this session another instruction…"
        readOnly={props.disabled ? true : undefined}
        value={props.prompt}
        {...promptEvents(props)}
      />
      {renderSessionImages({
        ...props,
        disabled: props.disabled,
        id: "follow-up-images",
      })}
      <button
        aria-describedby={props.availabilityDescriptionId}
        class="min-h-11 w-full self-stretch rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:self-end"
        disabled={props.disabled}
        type="submit"
      >
        {props.sending ? "Sending…" : (props.submitLabel ?? "Send")}
      </button>
      <p
        aria-live="polite"
        class="text-xs leading-5 text-slate-500"
        id={props.availabilityDescriptionId}
        role="status"
      >
        {props.availabilityLabel}
      </p>
    </form>
  );
}
