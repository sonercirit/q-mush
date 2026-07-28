import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import {
  AGENT_ATTACHMENT_MODALITIES,
  type AgentAttachmentModality,
} from "../shared/agent-attachments.ts";
import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import { SESSION_ATTACHMENT_FALLBACKS_PATH } from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";
import { modalityLabel } from "./model-modalities-client.tsx";
import type { SessionCredentialOption } from "./session-credential-option.ts";

export function SessionAttachmentFallbacks(props: {
  readonly credentials: readonly SessionCredentialOption[];
}): JSX.Element {
  const [credential, setCredential] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const [model, setModel] = createSignal("");
  const [modality, setModality] =
    createSignal<AgentAttachmentModality>("image");
  const [prompt, setPrompt] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const selectionButton = (
    selected: boolean,
    choose: () => void,
    label: string,
  ): JSX.Element => (
    <button
      aria-pressed={selected}
      class="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300"
      onClick={choose}
      type="button"
    >
      {label}
    </button>
  );
  const chooseCredential =
    (index: () => number): ((event: MouseEvent) => void) =>
    () => {
      setCredential(index());
    };
  const modalityButtons = createMemo(() =>
    AGENT_ATTACHMENT_MODALITIES.map((value) =>
      selectionButton(
        modality() === value,
        () => setModality(value),
        modalityLabel(value).replace("Pdf", "PDF"),
      ),
    ),
  );
  const save = async (): Promise<void> => {
    const selected = props.credentials[credential()];
    if (selected === undefined || model().trim().length === 0) {
      setError("Choose a credential and enter a fallback model.");
      return;
    }
    setError(undefined);
    setSaved(false);
    setSaving(true);
    try {
      await requestJson(SESSION_ATTACHMENT_FALLBACKS_PATH, {
        body: JSON.stringify({
          credentialId: selected.credential.id,
          modality: modality(),
          model: model().trim(),
          prompt: prompt().trim() || null,
          provider: selected.provider,
        } satisfies AttachmentFallbackSelection),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      setSaved(true);
    } catch {
      setError("That fallback model is unavailable for this modality.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <fieldset class="grid gap-3 rounded-xl border border-white/10 p-3 md:col-span-2">
      <legend class="px-1 text-sm font-medium text-slate-200">
        Attachment fallback model
      </legend>
      <p class="text-xs text-slate-500">
        Used when the current model cannot read an attachment natively.
      </p>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="text-xs text-slate-400">
          Modality
          <div class="mt-1 flex flex-wrap gap-1">{modalityButtons()}</div>
        </label>
        <label class="text-xs text-slate-400">
          Credential
          <div class="mt-1 flex flex-wrap gap-1">
            <For each={props.credentials}>
              {(option, index) => (
                <button
                  aria-pressed={credential() === index()}
                  class="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300"
                  onClick={(event) => {
                    chooseCredential(index)(event);
                  }}
                  type="button"
                >
                  {`${option.provider === "openai" ? "OpenAI" : "OpenRouter"} · ${option.credential.label}`}
                </button>
              )}
            </For>
          </div>
        </label>
        <label class="text-xs text-slate-400">
          Model
          <input
            class="mt-1 w-full rounded-lg bg-slate-900 p-2 text-sm text-white"
            onInput={(event) => setModel(event.currentTarget.value)}
            placeholder="provider/model"
            value={model()}
          />
        </label>
      </div>
      <label class="text-xs text-slate-400">
        Optional model prompt
        <textarea
          class="mt-1 min-h-16 w-full rounded-lg bg-slate-900 p-2 text-sm text-white"
          maxlength={4000}
          onInput={(event) => setPrompt(event.currentTarget.value)}
          placeholder="Describe what the fallback model should extract."
          value={prompt()}
        />
      </label>
      <div class="flex items-center gap-3">
        <button
          class="rounded-lg border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-50"
          disabled={saving() || props.credentials.length === 0}
          onClick={() => void save()}
          type="button"
        >
          {saving()
            ? "Saving…"
            : `Save ${modalityLabel(modality()).replace("Pdf", "PDF")} fallback`}
        </button>
        <Show when={saved()}>
          <span class="text-xs text-emerald-300">Saved</span>
        </Show>
        <Show when={error()}>
          {(message) => <span class="text-xs text-rose-300">{message()}</span>}
        </Show>
      </div>
    </fieldset>
  );
}
