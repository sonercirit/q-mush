import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import {
  AGENT_ATTACHMENT_MODALITIES,
  type AgentAttachmentModality,
} from "../shared/agent-attachments.ts";
import {
  modelSupportsAttachmentModality,
  type AttachmentFallbackSelection,
} from "../shared/attachment-fallback.ts";
import { SESSION_ATTACHMENT_FALLBACKS_PATH } from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { requestJson } from "./browser-http.ts";
import { RetryNotice } from "./collection.tsx";
import { modalityLabel } from "./model-modalities-client.tsx";
import type { SessionCredentialOption } from "./session-credential-option.ts";
import {
  modelProviderLabel,
  parseModelCredentialValue,
} from "./session-model-options.ts";
import {
  createSessionModelPickerState,
  SessionModelPickerFields,
} from "./session-model-picker.tsx";
import { OpenRouterProviderSelect } from "./session-provider-select.tsx";
import { discoverProviderUpdateProviders } from "./session-provider-update-controller.ts";

export function AttachmentFallbackSettings(props: {
  readonly credentials: readonly SessionCredentialOption[];
  readonly onDiscoverModels: Parameters<
    typeof createSessionModelPickerState
  >[1]["onDiscoverModels"];
}): JSX.Element {
  const [error, setError] = createSignal<string>();
  const [modality, setModality] =
    createSignal<AgentAttachmentModality>("image");
  const [providerCatalog, setProviderCatalog] =
    createSignal<Awaited<ReturnType<typeof discoverProviderUpdateProviders>>>();
  const [providerTag, setProviderTag] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const discoverFallbackModels: typeof props.onDiscoverModels = async (
    provider,
    credentialId,
  ) => {
    const selectedModality = modality();
    const result = await props.onDiscoverModels(provider, credentialId);
    return "error" in result
      ? result
      : {
          ...result,
          models: result.models.filter(({ inputModalities }) =>
            modelSupportsAttachmentModality(inputModalities, selectedModality),
          ),
        };
  };
  const picker = createSessionModelPickerState(
    { credential: "", model: "", reasoningEffort: "" },
    {
      get credentials() {
        return props.credentials;
      },
      onDiscoverModels: discoverFallbackModels,
    },
  );
  const [openProvider, setOpenProvider] = createSignal(false);

  createEffect(() => {
    const first = props.credentials[0];
    if (first === undefined || picker.draft().credential.length > 0) return;
    const credential = `${first.provider}:${first.credential.id}`;
    untrack(() => {
      picker.editor.actions.choose.credential(credential);
    });
  });

  const selectedCredential = () =>
    parseModelCredentialValue(picker.draft().credential);
  const discoverProviders = async (model: string): Promise<void> => {
    const credential = selectedCredential();
    setProviderTag("");
    setProviderCatalog(undefined);
    if (credential?.provider !== "openrouter" || model.length === 0) return;
    setProviderCatalog(
      await discoverProviderUpdateProviders(
        credential.credentialId,
        model,
        GLOBAL_WORKSPACE_ID,
      ),
    );
  };
  const selectModality = (value: string): void => {
    for (const candidate of AGENT_ATTACHMENT_MODALITIES) {
      if (candidate === value) {
        setModality(candidate);
        if (picker.draft().credential.length > 0) {
          void picker.editor.discover(picker.draft().credential);
        }
        return;
      }
    }
  };
  const save = async (): Promise<void> => {
    const credential = selectedCredential();
    if (credential === undefined || picker.draft().model.length === 0) {
      setError("Choose a global credential and fallback model.");
      return;
    }
    setError(undefined);
    setSaved(false);
    setSaving(true);
    try {
      await requestJson(SESSION_ATTACHMENT_FALLBACKS_PATH, {
        body: JSON.stringify({
          ...credential,
          modality: modality(),
          model: picker.draft().model,
          openRouterProviderTag:
            credential.provider === "openrouter" && providerTag().length > 0
              ? providerTag()
              : null,
        } satisfies AttachmentFallbackSelection),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      setSaved(true);
    } catch {
      setError("That fallback model or serving provider is unavailable.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="attachment-fallback-settings-title"
      class="rounded-3xl border border-white/10 bg-slate-900/80 p-4 sm:p-6 lg:p-8"
      data-attachment-fallback-settings="global"
    >
      <h2
        class="text-2xl font-semibold text-white"
        id="attachment-fallback-settings-title"
      >
        Global attachment fallback settings
      </h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
        These fallback models apply to every session when its selected model
        cannot read a file modality. Use explain_file to request an explanation
        with optional instructions for that call.
      </p>
      <div class="mt-5 grid gap-4 sm:grid-cols-2">
        <label class="text-sm font-medium text-slate-200">
          Modality
          <select
            class="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-sm text-white"
            name="attachmentFallbackModality"
            onChange={(event) => {
              selectModality(event.currentTarget.value);
            }}
            value={modality()}
          >
            <For each={AGENT_ATTACHMENT_MODALITIES}>
              {(value) => (
                <option value={value}>
                  {modalityLabel(value).replace("Pdf", "PDF")}
                </option>
              )}
            </For>
          </select>
        </label>
        <SessionModelPickerFields
          catalog={picker.editor.catalog()}
          credentialEmptyLabel="No global model credentials"
          credentialOptions={props.credentials.map(
            ({ credential, provider }) => ({
              label: `${modelProviderLabel(provider)} · ${credential.label}`,
              value: `${provider}:${credential.id}`,
            }),
          )}
          disabled={saving()}
          hideReasoning
          idPrefix="attachment-fallback"
          namePrefix="attachmentFallback"
          onChooseCredential={(value) => {
            picker.editor.actions.choose.credential(value);
            void discoverProviders("");
          }}
          onChooseModel={(value) => {
            picker.editor.actions.choose.model(value);
            void discoverProviders(value);
          }}
          onChooseReasoning={picker.editor.actions.choose.reasoning}
          onToggle={(name) =>
            picker.setOpen(picker.open() === name ? undefined : name)
          }
          open={picker.open()}
          selection={picker.draft()}
        />
        <Show when={selectedCredential()?.provider === "openrouter"}>
          <OpenRouterProviderSelect
            controller={{
              chooseOption: (_name, value) => {
                setProviderTag(value);
                setOpenProvider(false);
              },
              retryProviders: () => {
                void discoverProviders(picker.draft().model);
              },
              toggleSelect: () => setOpenProvider(!openProvider()),
            }}
            creating={saving()}
            discovery={{
              catalog: providerCatalog(),
              error: undefined,
              key: "global-attachment-fallback",
              loading: false,
            }}
            open={openProvider()}
            selectedValue={providerTag()}
          />
        </Show>
      </div>
      <RetryNotice
        error={picker.request.error()}
        onRetry={() => {
          void picker.editor.discover(picker.draft().credential);
        }}
        retryLabel="Retry model discovery"
      />
      <div class="mt-5 flex items-center gap-3">
        <button
          class="rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          disabled={saving() || props.credentials.length === 0}
          onClick={() => void save()}
          type="button"
        >
          {saving() ? "Saving…" : "Save global fallback"}
        </button>
        <Show when={saved()}>
          <span class="text-xs text-emerald-300">Saved</span>
        </Show>
        <Show when={error()}>
          {(message) => <span class="text-xs text-rose-300">{message()}</span>}
        </Show>
      </div>
    </section>
  );
}
