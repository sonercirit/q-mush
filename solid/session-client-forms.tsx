import { Show, type JSX } from "solid-js";
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
  readonly availabilityDescriptionId: string;
  readonly availabilityLabel: string;
  readonly continueVisible: boolean;
  readonly disabled: boolean;
  readonly onContinue: () => void;
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

function hasPromptInput(
  prompt: string,
  images: readonly AgentImage[],
): boolean {
  return prompt.trim().length > 0 || images.length > 0;
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
  readonly availabilityDescriptionId: string;
  readonly available: boolean;
  readonly label: string;
}): JSX.Element {
  return (
    <button
      aria-describedby={props.availabilityDescriptionId}
      aria-keyshortcuts={shortcutKeys(SHORTCUT_ACTIONS.sendFollowUp)}
      class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!props.available}
      type="submit"
    >
      {props.label}
      <ShortcutHint action={SHORTCUT_ACTIONS.sendFollowUp} />
    </button>
  );
}

function registerComposerShortcut(
  action: typeof SHORTCUT_ACTIONS.startSession,
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

function sendAvailable(props: SessionFollowUpProps): boolean {
  return (
    !props.disabled &&
    !props.sending &&
    hasPromptInput(props.prompt, props.images)
  );
}

function continueAvailable(props: SessionFollowUpProps): boolean {
  return props.continueVisible && !props.disabled && !props.sending;
}

function registerFollowUpShortcuts(
  props: SessionFollowUpProps,
): (element: HTMLTextAreaElement) => void {
  let prompt: HTMLTextAreaElement | undefined;
  const target = (): HTMLTextAreaElement | undefined => prompt;
  registerShortcut(
    SHORTCUT_ACTIONS.sendFollowUp,
    () => sendAvailable(props),
    () => {
      prompt?.form?.requestSubmit();
    },
    target,
  );
  registerShortcut(
    SHORTCUT_ACTIONS.continueSession,
    () => continueAvailable(props),
    props.onContinue,
    target,
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

export function SessionStartButton(props: {
  readonly available: boolean;
  readonly pending: boolean;
}): JSX.Element {
  return (
    <button
      aria-keyshortcuts={shortcutKeys(SHORTCUT_ACTIONS.startSession)}
      class="shrink-0 rounded-xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!props.available || props.pending}
      type="submit"
    >
      {props.pending ? "Starting…" : "Start session"}
      <ShortcutHint action={SHORTCUT_ACTIONS.startSession} />
    </button>
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
      hasPromptInput(props.prompt, props.images),
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
  const promptRef = registerFollowUpShortcuts(props);

  return (
    <form
      aria-label="Send another instruction"
      class="flex min-w-0 flex-1 flex-col gap-3"
      data-session-composer="true"
      onSubmit={(event) => {
        event.preventDefault();
        if (sendAvailable(props)) {
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
        placeholder="Give this session another instruction…"
        readOnly={props.disabled ? true : undefined}
        ref={promptRef}
        value={props.prompt}
        {...promptEvents(props)}
      />
      {renderSessionImages({
        ...props,
        disabled: props.disabled || props.sending,
        id: "follow-up-images",
      })}
      <div class="flex flex-wrap items-end gap-3">
        <SessionSubmitButton
          availabilityDescriptionId={props.availabilityDescriptionId}
          available={sendAvailable(props)}
          label={props.sending ? "Sending…" : "Send"}
        />
        <Show when={props.continueVisible}>
          <button
            aria-describedby={props.availabilityDescriptionId}
            aria-keyshortcuts={shortcutKeys(SHORTCUT_ACTIONS.continueSession)}
            aria-label="Continue without another instruction"
            class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!continueAvailable(props)}
            onClick={props.onContinue}
            type="button"
          >
            Continue without message
            <ShortcutHint action={SHORTCUT_ACTIONS.continueSession} />
          </button>
        </Show>
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
