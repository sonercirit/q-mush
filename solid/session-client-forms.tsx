import { type JSX } from "solid-js";
import type { AgentImage } from "../shared/agent-images.ts";
import { SessionImageInput } from "./session-image-client.tsx";
import { readPastedAgentImageFiles } from "./session-image-input.ts";
import {
  registerShortcut,
  ShortcutHint,
  shortcutKeys,
} from "./shortcut-client.tsx";
import { SHORTCUT_ACTIONS } from "./shortcut-registry.ts";

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
  readonly available: boolean;
  readonly disabled: boolean;
  readonly prompt: string;
}

interface SessionFollowUpProps extends PromptEventProps, SessionImagesProps {
  readonly available: boolean;
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

function SessionSubmitButton(props: {
  readonly label: string;
  readonly pending: boolean;
}): JSX.Element {
  return (
    <button
      aria-keyshortcuts={shortcutKeys(SHORTCUT_ACTIONS.sendFollowUp)}
      class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
      disabled={props.pending}
      type="submit"
    >
      {props.label}
      <ShortcutHint action={SHORTCUT_ACTIONS.sendFollowUp} />
    </button>
  );
}

function registerComposerShortcut(
  action:
    typeof SHORTCUT_ACTIONS.sendFollowUp | typeof SHORTCUT_ACTIONS.startSession,
  available: () => boolean,
): (element: HTMLTextAreaElement) => void {
  let prompt: HTMLTextAreaElement | undefined;
  registerShortcut(
    action,
    available,
    () => {
      prompt?.form?.requestSubmit();
    },
    () => prompt,
  );
  return (element) => {
    prompt = element;
  };
}

function SessionPromptTextarea(
  props: PromptEventProps & {
    readonly class: string;
    readonly disabled: boolean;
    readonly id?: string;
    readonly placeholder: string;
    readonly prompt: string;
    readonly ref: (element: HTMLTextAreaElement) => void;
  },
): JSX.Element {
  return (
    <textarea
      class={props.class}
      disabled={props.disabled}
      id={props.id}
      name="prompt"
      placeholder={props.placeholder}
      ref={props.ref}
      value={props.prompt}
      {...promptEvents(props)}
    />
  );
}

export function SessionPromptInput(
  props: SessionPromptInputProps,
): JSX.Element {
  const promptRef = registerComposerShortcut(
    SHORTCUT_ACTIONS.startSession,
    () =>
      props.available &&
      !props.disabled &&
      (props.prompt.trim().length > 0 || props.images.length > 0),
  );

  return (
    <div class="lg:col-span-2">
      <label class="text-sm font-medium text-slate-200" for="session-prompt">
        Task
      </label>
      <SessionPromptTextarea
        {...props}
        class="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm leading-6 text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        id="session-prompt"
        placeholder="Describe the change you want the agent to make…"
        ref={promptRef}
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
  const promptRef = registerComposerShortcut(
    SHORTCUT_ACTIONS.sendFollowUp,
    () => props.available && !props.sending,
  );

  return (
    <form
      class="flex min-w-0 flex-1 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <SessionPromptTextarea
        {...props}
        class="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        disabled={props.sending}
        placeholder="Give this session another instruction…"
        ref={promptRef}
      />
      {renderSessionImages({
        disabled: props.sending,
        id: "follow-up-images",
        ...props,
      })}
      <SessionSubmitButton
        label={props.sending ? "Sending…" : "Send"}
        pending={props.sending}
      />
    </form>
  );
}
