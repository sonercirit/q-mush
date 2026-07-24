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

interface SessionFollowUpAction {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly shortcut: string;
  readonly shortcutKeys: string;
}

interface SessionFollowUpProps extends PromptEventProps, SessionImagesProps {
  readonly actions: readonly SessionFollowUpAction[];
  readonly availabilityDescriptionId: string;
  readonly availabilityLabel: string;
  readonly disabled: boolean;
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
      <div class="flex flex-wrap justify-end gap-2">
        {props.actions.map((action) => (
          <button
            aria-describedby={props.availabilityDescriptionId}
            aria-keyshortcuts={action.shortcutKeys}
            class="rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={props.disabled || action.disabled === true}
            onClick={action.onClick}
            type="button"
          >
            <span>{props.sending ? "Sending…" : action.label}</span>
            <kbd class="ml-2 text-xs font-normal opacity-70">
              {action.shortcut}
            </kbd>
          </button>
        ))}
      </div>
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
