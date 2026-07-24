import { createSignal, For, Show, type JSX } from "solid-js";
import {
  PROMPT_BODY_MAXIMUM_LENGTH,
  PROMPT_NAME_MAXIMUM_LENGTH,
  type Prompt,
  type PromptInput,
} from "../shared/prompt-model.ts";
import { RetryNotice } from "./collection.tsx";
import type { PromptBankController } from "./prompt-state.ts";
import { renderDebugBoundary } from "./render-debug.tsx";

interface PromptBankProps {
  readonly controller: PromptBankController;
  readonly onInsert: (body: string, replace: boolean) => boolean;
}

const FIELD_CLASSES =
  "mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none";
const SECONDARY_BUTTON =
  "rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300";

function PromptFields(props: {
  readonly body: string;
  readonly disabled: boolean;
  readonly idPrefix: string;
  readonly name: string;
  readonly namePrefix: "" | "edit";
  readonly onInput: (field: keyof PromptInput, value: string) => void;
  readonly submitLabel: string;
}): JSX.Element {
  const nameId = (): string => `${props.idPrefix}-name`;
  const bodyId = (): string => `${props.idPrefix}-body`;
  return (
    <>
      <div>
        <label class="text-sm font-medium text-slate-200" for={nameId()}>
          Name
        </label>
        <input
          class={FIELD_CLASSES}
          disabled={props.disabled}
          id={nameId()}
          maxLength={PROMPT_NAME_MAXIMUM_LENGTH}
          name={`${props.namePrefix}Name`}
          onInput={(event) => {
            props.onInput("name", event.currentTarget.value);
          }}
          placeholder="Repository review"
          required
          type="text"
          value={props.name}
        />
      </div>
      <div>
        <label class="text-sm font-medium text-slate-200" for={bodyId()}>
          Prompt body
        </label>
        <textarea
          class={`${FIELD_CLASSES} min-h-28 resize-y leading-6`}
          disabled={props.disabled}
          id={bodyId()}
          maxLength={PROMPT_BODY_MAXIMUM_LENGTH}
          name={`${props.namePrefix}Body`}
          onInput={(event) => {
            props.onInput("body", event.currentTarget.value);
          }}
          placeholder="Describe the reusable task or instruction…"
          required
          value={props.body}
        />
      </div>
      <p class="sr-only">{props.submitLabel}</p>
    </>
  );
}

function submitPrompt(event: SubmitEvent, save: () => Promise<void>): void {
  event.preventDefault();
  void save();
}

function PromptForm(props: {
  readonly children: JSX.Element;
  readonly class: string;
  readonly save: () => Promise<void>;
}): JSX.Element {
  return (
    <form
      class={props.class}
      onSubmit={(event) => {
        submitPrompt(event, props.save);
      }}
    >
      {props.children}
    </form>
  );
}

function SaveButton(props: {
  readonly busy: boolean;
  readonly class: string;
  readonly disabled: boolean;
  readonly idleLabel: string;
  readonly savingLabel: string;
}): JSX.Element {
  return (
    <button class={props.class} disabled={props.disabled} type="submit">
      {props.busy ? props.savingLabel : props.idleLabel}
    </button>
  );
}

function EditPrompt(props: PromptBankProps): JSX.Element {
  const controller = props.controller;
  const state = controller.view;
  const cancel = (): void => {
    controller.cancelEdit();
  };
  return (
    <PromptForm
      class="mt-4 grid gap-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.05] p-4"
      save={() => props.controller.saveEdit()}
    >
      <PromptFields
        body={state().editDraft.body}
        disabled={state().saving}
        idPrefix={`prompt-edit-${state().editingId ?? "none"}`}
        name={state().editDraft.name}
        namePrefix="edit"
        onInput={(field, value) => {
          props.controller.setEditField(field, value);
        }}
        submitLabel="Edit the selected prompt"
      />
      <div class="flex flex-wrap justify-end gap-2">
        <button
          class={SECONDARY_BUTTON}
          disabled={state().saving}
          onClick={cancel}
          type="button"
        >
          Cancel
        </button>
        <SaveButton
          busy={state().saving}
          class="rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
          disabled={state().saving}
          idleLabel="Save changes"
          savingLabel="Saving changes…"
        />
      </div>
    </PromptForm>
  );
}

function promptBusy(state: ReturnType<PromptBankController["view"]>): boolean {
  return state.loading || state.saving || state.removingId !== undefined;
}

function PromptItem(
  props: PromptBankProps & { readonly prompt: Prompt },
): JSX.Element {
  const state = props.controller.view;
  const selected = (): boolean => state().selectedId === props.prompt.id;
  const editing = (): boolean => state().editingId === props.prompt.id;
  const actionsDisabled = (): boolean => promptBusy(state());
  return (
    <li
      class={`rounded-2xl border p-4 ${selected() ? "border-emerald-300/40 bg-emerald-300/[0.07]" : "border-white/10 bg-slate-950/60"}`}
      data-prompt-id={props.prompt.id}
      {...renderDebugBoundary(
        `prompt:${props.prompt.id}`,
        `Prompt: ${props.prompt.name}`,
      )}
    >
      <button
        aria-pressed={selected()}
        class="w-full text-left"
        disabled={actionsDisabled()}
        onClick={() => {
          props.controller.select(props.prompt.id);
        }}
        type="button"
      >
        <span class="block font-semibold text-white">{props.prompt.name}</span>
        <span class="mt-2 line-clamp-3 block whitespace-pre-line text-sm leading-6 text-slate-400">
          {props.prompt.body}
        </span>
      </button>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button
          class={`${SECONDARY_BUTTON} hover:text-cyan-200`}
          disabled={actionsDisabled()}
          onClick={() => {
            props.controller.beginEdit(props.prompt.id);
          }}
          type="button"
        >
          Edit
        </button>
        <button
          class={`${SECONDARY_BUTTON} hover:text-rose-200 disabled:opacity-60`}
          data-delete-prompt="true"
          disabled={actionsDisabled()}
          onClick={() => {
            props.controller.requestDelete(props.prompt.id);
          }}
          type="button"
        >
          {state().removingId === props.prompt.id ? "Deleting…" : "Delete"}
        </button>
      </div>
      <Show when={state().confirmDeleteId === props.prompt.id}>
        <div
          aria-labelledby={`prompt-delete-${props.prompt.id}`}
          class="mt-4 rounded-xl border border-rose-300/30 bg-rose-300/10 p-4"
          role="alertdialog"
        >
          <p id={`prompt-delete-${props.prompt.id}`}>
            Delete this saved prompt?
          </p>
          <p class="mt-2 text-sm text-rose-100/70">
            Existing session drafts are unchanged.
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <button
              class={SECONDARY_BUTTON}
              onClick={() => {
                props.controller.cancelDelete();
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              autofocus
              class="rounded-xl bg-rose-300 px-4 py-2 text-sm font-semibold text-slate-950"
              data-confirm-prompt-delete="true"
              onClick={() => {
                void props.controller.remove(props.prompt.id);
              }}
              type="button"
            >
              Delete prompt
            </button>
          </div>
        </div>
      </Show>
      <Show when={editing()}>
        <EditPrompt {...props} />
      </Show>
    </li>
  );
}

function PromptList(
  props: PromptBankProps & {
    readonly busy: boolean;
    readonly confirmInsert: boolean;
    readonly onCancelInsert: () => void;
    readonly onConfirmInsert: () => void;
    readonly onInsertRequest: () => void;
  },
): JSX.Element {
  const state = props.controller.view;
  return (
    <Show
      fallback={
        <p class="mt-6 text-sm text-slate-400" role="status">
          Loading prompts…
        </p>
      }
      when={state().prompts}
    >
      {(prompts) => (
        <Show
          fallback={
            <div class="mt-6 rounded-2xl border border-dashed border-white/15 p-6 text-sm text-slate-400">
              No saved prompts yet. Create one above for recurring tasks.
            </div>
          }
          when={prompts().length > 0}
        >
          <ul class="mt-6 grid gap-3 md:grid-cols-2">
            <For each={prompts()}>
              {(prompt) => <PromptItem {...props} prompt={prompt} />}
            </For>
          </ul>
          <button
            class="mt-5 rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-5 py-3 font-semibold text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
            data-insert-prompt="true"
            disabled={state().selectedId === undefined || props.busy}
            onClick={props.onInsertRequest}
            type="button"
          >
            Insert into task
          </button>
          <Show when={props.confirmInsert}>
            <div
              aria-labelledby="prompt-insert-confirmation"
              class="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4"
              role="alertdialog"
            >
              <p id="prompt-insert-confirmation">
                Replace the current task draft?
              </p>
              <p class="mt-2 text-sm text-amber-100/70">
                Attached images and the rest of the setup stay in place.
              </p>
              <button
                class={SECONDARY_BUTTON}
                onClick={props.onCancelInsert}
                type="button"
              >
                Keep current draft
              </button>
              <button
                autofocus
                class="ml-2 rounded-xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950"
                data-confirm-prompt-insert="true"
                onClick={props.onConfirmInsert}
                type="button"
              >
                Replace task draft
              </button>
            </div>
          </Show>
        </Show>
      )}
    </Show>
  );
}

export function PromptBank(props: PromptBankProps): JSX.Element {
  const state = props.controller.view;
  const busy = (): boolean => promptBusy(state());
  const [confirmInsert, setConfirmInsert] = createSignal<string>();
  const insert = (replace: boolean): void => {
    const selectedId = state().selectedId;
    const inserted = props.controller.insertSelected((body) =>
      props.onInsert(body, replace),
    );
    setConfirmInsert(
      !inserted && !replace && selectedId !== undefined
        ? selectedId
        : undefined,
    );
    if (inserted) {
      queueMicrotask(() => {
        document.querySelector<HTMLTextAreaElement>("#session-prompt")?.focus();
      });
    }
  };
  const retry = (): void => {
    void props.controller.load();
  };
  const createField = (field: keyof PromptInput, value: string): void => {
    props.controller.setCreateField(field, value);
  };
  return (
    <section
      aria-labelledby="prompt-bank-title"
      class="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
      data-prompt-bank="true"
      {...renderDebugBoundary("prompt-bank", "Prompt bank")}
    >
      <p class="text-sm font-medium text-cyan-300">Reusable instructions</p>
      <h2 class="mt-2 text-2xl font-semibold text-white" id="prompt-bank-title">
        Prompt bank
      </h2>
      <p class="mt-3 max-w-3xl leading-7 text-slate-400">
        Save private prompts on this Q Mush server, then copy one into the new
        session task and edit the copied draft freely.
      </p>
      <PromptForm
        class="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-slate-900/70 p-5 lg:grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)_auto] lg:items-end"
        save={() => props.controller.create()}
      >
        <PromptFields
          body={state().createDraft.body}
          disabled={busy()}
          idPrefix="prompt"
          name={state().createDraft.name}
          namePrefix=""
          onInput={createField}
          submitLabel="Create a new saved prompt"
        />
        <SaveButton
          busy={state().saving}
          class="rounded-xl bg-cyan-300 px-5 py-3 font-semibold text-slate-950 disabled:opacity-60"
          disabled={busy()}
          idleLabel="Save prompt"
          savingLabel="Saving prompt…"
        />
      </PromptForm>
      <RetryNotice error={state().error} onRetry={retry} />
      <PromptList
        {...props}
        busy={busy()}
        confirmInsert={confirmInsert() === state().selectedId}
        onCancelInsert={() => {
          setConfirmInsert(undefined);
        }}
        onConfirmInsert={() => {
          insert(true);
        }}
        onInsertRequest={() => {
          insert(false);
        }}
      />
    </section>
  );
}
