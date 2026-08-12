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

const PROMPT_SYNC_DELAY_MS = 150;
const COMPOSER_BUTTON_CLASSES =
  "min-h-11 w-full rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";

// Typing writes a local signal and syncs the shared draft on a short delay:
// per-keystroke patches of the whole session view state re-run every memo
// reading it, which froze Firefox on long prompts. Shortcut, action, and
// form-submit paths flush synchronously so submits always read the latest
// text.
function createLocalPromptEcho(options: {
  // With externalWins, a conflicting external write (insertPrompt) cancels
  // pending typing and replaces the local text, so an acknowledged insert
  // is never silently undone; without it (follow-up), in-progress typing
  // survives concurrent rollbacks.
  readonly externalWins?: boolean;
  readonly onInput: (value: string) => void;
  readonly prompt: () => string;
}) {
  const [textarea, setTextareaElement] = createSignal<
    HTMLInputElement | HTMLTextAreaElement
  >();
  const [localPrompt, setLocalPrompt] = createSignal(untrack(options.prompt));
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const clearSyncTimer = (): void => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
  };
  const syncPrompt = (): void => {
    clearSyncTimer();
    if (localPrompt() !== options.prompt()) options.onInput(localPrompt());
  };
  const handleInput = (event: {
    readonly currentTarget: HTMLInputElement | HTMLTextAreaElement;
  }): void => {
    setLocalPrompt(event.currentTarget.value);
    clearSyncTimer();
    syncTimer = setTimeout(syncPrompt, PROMPT_SYNC_DELAY_MS);
  };
  const resetLocalPrompt = (): void => {
    clearSyncTimer();
    setLocalPrompt(options.prompt());
  };
  const setTextarea = (
    element: HTMLInputElement | HTMLTextAreaElement,
  ): void => {
    setTextareaElement(element);
  };
  const handleKeyDown = (
    event: SessionPromptKeyEvent,
    delegate: (event: SessionPromptKeyEvent) => void,
  ): void => {
    // Composer shortcuts requestSubmit() synchronously, so flush before
    // delegating; a pending timer syncs the draft shortly regardless.
    if (sessionComposerShortcut(event) !== undefined) {
      syncPrompt();
    }
    delegate(event);
  };
  createEffect(() => {
    // A capture-phase listener runs before the form's own submit handler,
    // so requestSubmit(), button.click(), and assistive-technology
    // activation all read a flushed draft even while the textarea is
    // focused with a pending sync.
    const form = textarea()?.form;
    if (form === null || form === undefined) return;
    form.addEventListener("submit", syncPrompt, true);
    onCleanup(() => {
      form.removeEventListener("submit", syncPrompt, true);
    });
  });
  createEffect(
    on(options.prompt, (prompt, previousPrompt) => {
      if (prompt === previousPrompt) return;
      if (
        options.externalWins === true ||
        syncTimer === undefined ||
        textarea() !== document.activeElement
      ) {
        clearSyncTimer();
        setLocalPrompt(prompt);
      }
    }),
  );
  onCleanup(clearSyncTimer);
  return {
    handleInput,
    handleKeyDown,
    localPrompt,
    resetLocalPrompt,
    setTextarea,
    syncPrompt,
  };
}

function promptEcho(
  props: Pick<PromptEventProps, "onInput"> & { readonly prompt: string },
  externalWins = false,
) {
  return createLocalPromptEcho({
    externalWins,
    onInput: (value) => {
      props.onInput(value);
    },
    prompt: () => props.prompt,
  });
}

export function SessionDraftEchoInput(props: {
  readonly disabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly numeric?: boolean;
  readonly onInput: (value: string) => void;
  readonly placeholder: string;
  readonly value: string;
}): JSX.Element {
  const syncDraft = (value: string): void => {
    props.onInput(value);
  };
  const echo = createLocalPromptEcho({
    onInput: syncDraft,
    prompt: () => props.value,
  });
  return (
    <input
      class="mt-2 min-w-0 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
      disabled={props.disabled}
      id={props.id}
      name={props.name}
      onBlur={echo.syncPrompt}
      onInput={echo.handleInput}
      placeholder={props.placeholder}
      ref={echo.setTextarea}
      {...(props.numeric === true
        ? { min: "1", step: "1", type: "number" }
        : { type: "text" })}
      value={echo.localPrompt()}
    />
  );
}

function promptEvents(props: PromptEventProps) {
  return {
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
  // insertPrompt acknowledges success, so an external write must win over
  // in-flight typing here; the follow-up composer keeps typing priority.
  const echo = promptEcho(props, true);
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
        // The capture-phase form-submit listener guarantees click submits;
        // blur is a secondary flush for tab-away and window switches.
        onBlur={echo.syncPrompt}
        onInput={echo.handleInput}
        onKeyDown={(event) => {
          echo.handleKeyDown(event, props.onKeyDown);
        }}
        onPaste={promptEvents(props).onPaste}
        placeholder="Describe the change you want the agent to make…"
        ref={echo.setTextarea}
        value={echo.localPrompt()}
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
  const echo = promptEcho(props);
  const { localPrompt, syncPrompt } = echo;
  const handleKeyDown = (event: SessionPromptKeyEvent): void => {
    echo.handleKeyDown(event, props.onKeyDown);
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
      () => props.sessionId,
      (sessionId, previousSessionId) => {
        if (
          previousSessionId !== undefined &&
          sessionId !== previousSessionId
        ) {
          echo.resetLocalPrompt();
        }
      },
    ),
  );

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
        onInput={echo.handleInput}
        onKeyDown={handleKeyDown}
        onPaste={promptEvents(props).onPaste}
        placeholder="Give this session another instruction…"
        {...(props.disabled ? { readOnly: true } : {})}
        ref={echo.setTextarea}
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
