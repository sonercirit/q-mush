import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import type { AgentImage } from "../shared/agent-images.ts";
import { SessionImageInput } from "./session-image-client.tsx";
import { readPastedAgentImageFiles } from "./session-image-input.ts";
import {
  sessionComposerShortcut,
  SessionShortcutHint,
  type SessionComposerShortcut,
  type SessionShortcut,
} from "./session-pending-client.tsx";

interface SessionImagesProps {
  readonly images: readonly AgentImage[];
  readonly onAddImages: (files: readonly File[]) => void;
  readonly onRemoveImage: (index: number) => void;
}

interface PromptEventProps {
  readonly onAddImages: SessionImagesProps["onAddImages"];
  readonly onInput: (value: string) => void;
}

type SessionPromptKeyEvent = KeyboardEvent & {
  readonly currentTarget: HTMLTextAreaElement;
};

interface SessionPromptInputProps extends PromptEventProps, SessionImagesProps {
  readonly disabled: boolean;
  readonly onKeyDown: (event: SessionPromptKeyEvent) => void;
  readonly prompt: string;
}

interface SessionFollowUpProps extends PromptEventProps, SessionImagesProps {
  readonly availabilityDescriptionId: string;
  readonly availabilityLabel: string;
  readonly disabled: boolean;
  readonly onContinue: (() => void) | undefined;
  readonly onKeyDown: (event: SessionPromptKeyEvent) => void;
  readonly onSteer: (() => void) | undefined;
  readonly onSubmit: () => void;
  readonly prompt: string;
  readonly sending: boolean;
  readonly sessionId: string;
  readonly shortcuts: SessionShortcut;
  readonly submitLabel?: string;
  readonly submitShortcut: SessionComposerShortcut;
}

const FOLLOW_UP_SYNC_DELAY_MS = 150;
const COMPOSER_BUTTON_CLASSES =
  "min-h-11 w-full rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";

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
  props: SessionImagesProps & { readonly disabled: boolean },
  id: string,
): JSX.Element {
  return (
    <SessionImageInput
      disabled={props.disabled}
      id={id}
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
        onKeyDown={(event) => {
          props.onKeyDown(event);
        }}
        placeholder="Describe the change you want the agent to make…"
        value={props.prompt}
        {...promptEvents(props)}
      />
      <div class="mt-3">{renderSessionImages(props, "session-images")}</div>
    </div>
  );
}

interface ComposerActionProps {
  readonly descriptionId: string;
  readonly disabled: boolean;
  readonly keys: string;
}

function composerActionProps(
  descriptionId: string,
  disabled: boolean,
  keys: string,
): ComposerActionProps {
  return { descriptionId, disabled, keys };
}

export function SessionFollowUp(props: SessionFollowUpProps): JSX.Element {
  const [localPrompt, setLocalPrompt] = createSignal(
    untrack(() => props.prompt),
  );
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const clearSyncTimer = (): void => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
  };
  const syncPrompt = (): void => {
    clearSyncTimer();
    if (localPrompt() !== props.prompt) props.onInput(localPrompt());
  };
  const schedulePromptSync = (): void => {
    clearSyncTimer();
    syncTimer = setTimeout(syncPrompt, FOLLOW_UP_SYNC_DELAY_MS);
  };
  const handleInput = (
    event: InputEvent & { readonly currentTarget: HTMLTextAreaElement },
  ): void => {
    setLocalPrompt(event.currentTarget.value);
    schedulePromptSync();
  };
  const handleKeyDown = (
    event: KeyboardEvent & { readonly currentTarget: HTMLTextAreaElement },
  ): void => {
    if (!props.disabled && sessionComposerShortcut(event) !== undefined) {
      syncPrompt();
    }
    props.onKeyDown(event);
  };
  const runAction = (action: (() => void) | undefined): void => {
    syncPrompt();
    action?.();
  };
  const submit = (): void => {
    runAction(props.onSubmit);
  };
  const submitShortcut = (): {
    readonly keys: string;
    readonly label: string;
  } =>
    props.submitShortcut === "follow_up"
      ? {
          keys: props.shortcuts.followUpKeys,
          label: props.shortcuts.followUpLabel,
        }
      : {
          keys: props.shortcuts.steerKeys,
          label: props.shortcuts.steerLabel,
        };
  const steerAction = (): ComposerActionProps =>
    composerActionProps(
      props.availabilityDescriptionId,
      props.disabled || props.onSteer === undefined,
      props.shortcuts.steerKeys,
    );
  const continueAction = (): ComposerActionProps =>
    composerActionProps(
      props.availabilityDescriptionId,
      props.disabled || props.onContinue === undefined,
      props.shortcuts.followUpKeys,
    );
  const promptValue = (): string => {
    return props.sessionId.length > 0 ? localPrompt() : "";
  };
  createEffect(
    on(
      () => props.prompt,
      (prompt, previousPrompt) => {
        if (
          prompt !== previousPrompt &&
          (syncTimer === undefined || textarea() !== document.activeElement)
        ) {
          setLocalPrompt(prompt);
        }
      },
    ),
  );
  createEffect(
    on(
      () => props.sessionId,
      (sessionId, previousSessionId) => {
        if (
          previousSessionId !== undefined &&
          sessionId !== previousSessionId
        ) {
          clearSyncTimer();
          setLocalPrompt(props.prompt);
        }
      },
    ),
  );
  onCleanup(clearSyncTimer);

  return (
    <form
      aria-label="Send another instruction"
      class="flex min-w-0 flex-1 flex-col gap-3"
      data-session-composer="true"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.disabled) {
          submit();
        }
      }}
    >
      <textarea
        aria-describedby={props.availabilityDescriptionId}
        aria-disabled={props.disabled}
        aria-label="Follow-up instruction"
        class="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        name="prompt"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={promptEvents(props).onPaste}
        placeholder="Give this session another instruction…"
        {...(props.disabled ? { readOnly: true } : {})}
        ref={setTextarea}
        value={promptValue()}
      />
      {renderSessionImages(props, "follow-up-images")}
      <div
        class="flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:justify-end"
        data-session-composer-actions="true"
      >
        <Show when={props.onSteer !== undefined}>
          <button
            aria-describedby={steerAction().descriptionId}
            aria-keyshortcuts={steerAction().keys}
            class={COMPOSER_BUTTON_CLASSES}
            data-session-steer="true"
            disabled={steerAction().disabled}
            onClick={() => {
              runAction(props.onSteer);
            }}
            title={`Steer (${props.shortcuts.steerLabel})`}
            type="button"
          >
            <span>Steer</span>
            <SessionShortcutHint label={props.shortcuts.steerLabel} />
          </button>
        </Show>
        <button
          aria-describedby={props.availabilityDescriptionId}
          aria-keyshortcuts={submitShortcut().keys}
          class={COMPOSER_BUTTON_CLASSES}
          disabled={props.disabled}
          title={`${props.submitLabel ?? "Send"} (${submitShortcut().label})`}
          type="submit"
        >
          <span>
            {props.sending ? "Sending…" : (props.submitLabel ?? "Send")}
          </span>
          <SessionShortcutHint label={submitShortcut().label} />
        </button>
        <Show when={props.onContinue !== undefined}>
          <button
            aria-describedby={continueAction().descriptionId}
            aria-keyshortcuts={continueAction().keys}
            aria-label="Continue without another instruction"
            class={COMPOSER_BUTTON_CLASSES}
            disabled={continueAction().disabled}
            onClick={() => {
              runAction(props.onContinue);
            }}
            title={`Continue without message (${props.shortcuts.followUpLabel})`}
            type="button"
          >
            <span>Continue without message</span>
            <SessionShortcutHint label={props.shortcuts.followUpLabel} />
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
